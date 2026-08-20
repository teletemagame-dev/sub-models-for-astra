/**
 * One CLI run, as an async iterable of events.
 *
 * The generator is the whole cancellation story: the caller stops pulling —
 * because a tool call arrived, because Astra hung up, because the turn ran out
 * of time — and `finally` kills the process. There is no separate stop handle
 * to forget to call.
 *
 * Killing matters more here than in most bridges. The shim never answers a
 * tool call, so a CLI that is not killed waits forever, and a forgotten one is
 * a process holding a subscription session open with nobody reading it.
 */

import { spawn } from "node:child_process";
import type { Backend, BackendEvent, LaunchSpec } from "./backends/types.js";
import { newParseState } from "./backends/types.js";
import { resolveLauncher } from "./launcher.js";
import { readable } from "./diagnose.js";

export class CliMissing extends Error {
  constructor(command: string, label: string) {
    super(
      `${label} is not installed, or '${command}' is not on PATH. ` +
        `Install it and sign in with your subscription, then set the command in this plugin's settings.`,
    );
    this.name = "CliMissing";
  }
}

/**
 * The part of stderr worth repeating.
 *
 * Not the whole of it: a CLI that throws prints a stack, and forty frames of
 * somebody else's bundle in an error message crowd out the one sentence that
 * says what happened.
 */
function tail(text: string): string {
  return readable(text);
}

export async function* run(
  command: string,
  spec: LaunchSpec,
  backend: Backend,
  timeoutMs: number,
): AsyncIterable<BackendEvent> {
  // `spawn` throws EINVAL synchronously for a batch file rather than emitting
  // it, so a try around the call is not belt and braces — it is the only place
  // that failure can be caught.
  // An npm-installed CLI on Windows is a `.cmd` shim, which Node will not
  // spawn without a shell — and a shell is not on the table, because the
  // arguments carry a system prompt rather than a command line.
  const launcher = resolveLauncher(command);

  let child;
  try {
    child = spawn(launcher.command, [...launcher.prefix, ...spec.args], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // Both are set only by a backend that configures itself from disk
      // rather than from its command line, which today means Gemini and its
      // workspace settings file. `env` extends the environment rather than
      // replacing it: a CLI stripped of PATH and HOME cannot find itself,
      // let alone its login.
      cwd: spec.cwd,
      env: spec.env ? { ...process.env, ...spec.env } : process.env,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new CliMissing(command, backend.label);
    if (code === "EINVAL") {
      throw new Error(
        `'${command}' is a Windows batch shim this plugin could not read, and Node cannot run one directly. ` +
          `Point the command setting at the underlying executable, or at the .js the shim runs.`,
      );
    }
    throw err;
  }

  const queue: BackendEvent[] = [];
  let notify: (() => void) | null = null;
  let finished = false;
  let failure: Error | null = null;
  let stderr = "";
  const state = newParseState();

  const wake = () => {
    const fn = notify;
    notify = null;
    fn?.();
  };
  const push = (event: BackendEvent) => {
    queue.push(event);
    wake();
  };
  const end = (err: Error | null) => {
    if (finished) return;
    finished = true;
    failure = failure ?? err;
    wake();
  };

  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) for (const event of backend.parseLine(line, state)) push(event);
      nl = buffer.indexOf("\n");
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    // Bounded: a CLI in a retry loop can write megabytes, and none of it is
    // worth more than the last few lines.
    stderr = (stderr + chunk).slice(-8000);
  });

  child.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return end(new CliMissing(command, backend.label));
    if (err.code === "EINVAL") {
      // Reached only when the shim could not be read. Say what it is, because
      // "spawn EINVAL" tells nobody anything.
      return end(
        new Error(
          `'${command}' is a Windows batch shim this plugin could not read, and Node cannot run one directly. ` +
            `Point the command setting at the underlying executable, or at the .js the shim runs.`,
        ),
      );
    }
    end(err);
  });

  child.on("close", (code) => {
    if (buffer.trim()) for (const event of backend.parseLine(buffer.trim(), state)) push(event);
    end(
      code === 0 || code === null
        ? null
        : new Error(`${backend.label} exited with code ${code}. ${tail(stderr)}`),
    );
  });

  const timer = setTimeout(() => {
    end(new Error(`${backend.label} did not finish within ${Math.round(timeoutMs / 1000)} s.`));
  }, timeoutMs);

  // Write the prompt and close: `-p` reads until EOF, and a stdin left open is
  // a CLI that never starts. EPIPE here means the child died first, and the
  // close handler is the one with something useful to say about that.
  child.stdin.on("error", () => {});
  child.stdin.end(spec.stdin, "utf8");

  try {
    for (;;) {
      while (queue.length > 0) yield queue.shift() as BackendEvent;
      if (finished) break;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
    while (queue.length > 0) yield queue.shift() as BackendEvent;
    if (failure) throw failure;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}
