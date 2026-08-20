/**
 * Finding the CLIs, and asking whether they are usable.
 *
 * The plugin is useless until one of them is on the machine and logged in, and
 * that is a wall a new user hits before anything else works. This module says
 * which side of the wall they are on: what is installed, at what version, and
 * where.
 *
 * It used to install them too, from a pair of settings dropdowns. That is
 * taken back out, and the reason is worth keeping. A settings form has no
 * buttons, so the click had to be inferred from a config change — and the
 * daemon delivers the config several times when a plugin loads, each delivery
 * indistinguishable from a user having just turned the dial. The workaround
 * that survived was a timing window, which is a guess about the daemon's
 * behaviour standing between somebody and an unrequested `npm i -g` on their
 * machine. A guess is the wrong thing to have there, and `README.md` says in
 * four commands what the machinery was doing badly.
 *
 * Signing in was never done here at all, and could not be: every one of these
 * CLIs authenticates by opening a browser against an Anthropic, OpenAI or
 * Google account. Those credentials are the user's and touching them is not
 * this plugin's business.
 */

import { spawn } from "node:child_process";

import type { BackendId } from "./config.js";
import { resolveLauncher } from "./launcher.js";

export interface InstallPlan {
  /** `npm i -g <package>`, or a download the user must run themselves. */
  kind: "npm" | "download";
  /** The npm package, when `kind` is "npm". */
  packageName?: string;
  /** Where to get it, when `kind` is "download". */
  url?: string;
  /** Why it is not an npm install. */
  note?: string;
}

/** What setup can report on — the backends, and nothing else. */
export type SetupTarget = BackendId;

export const SETUP_TARGETS: readonly SetupTarget[] = ["claude", "codex"];

export const LABELS: Record<SetupTarget, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
};

/** The command to look for when the settings do not say. */
export const DEFAULT_COMMANDS: Record<SetupTarget, string> = {
  claude: "claude",
  codex: "codex",
};

export const INSTALL_PLANS: Record<SetupTarget, InstallPlan> = {
  claude: { kind: "npm", packageName: "@anthropic-ai/claude-code" },
  codex: { kind: "npm", packageName: "@openai/codex" },
};

/**
 * How to ask a CLI whether it is signed in, without spending anything.
 *
 * Every one of them turned out to have a free way to answer, which was worth
 * looking for: "installed" and "usable" are different states, and a plugin
 * that reports only the first sends people to debug the wrong thing.
 *
 * `claude auth status` also returns the account's email address. It is read
 * for `loggedIn` and nothing else — a log line is not the place to put
 * somebody's email, and this plugin has no reason to know it.
 */
interface AuthProbe {
  args: string[];
  /** True when the output says signed in, false when it says not. */
  reads(out: string, ok: boolean): boolean | null;
  /** A whole instruction, not a bare command: one of these is not a command. */
  fix: string;
}

const AUTH_PROBES: Record<SetupTarget, AuthProbe | null> = {
  claude: {
    args: ["auth", "status"],
    reads: (out) => {
      try {
        return Boolean((JSON.parse(out) as { loggedIn?: boolean }).loggedIn);
      } catch {
        return /logged\s*in|authenticated/i.test(out) ? true : null;
      }
    },
    fix: "run 'claude auth login' in a terminal",
  },
  codex: {
    args: ["login", "status"],
    reads: (out, ok) => (/logged in/i.test(out) ? true : ok ? null : false),
    fix: "run 'codex login' in a terminal",
  },
};

export interface CliStatus {
  backend: SetupTarget;
  label: string;
  /** The command as configured. */
  command: string;
  /** Where it was actually found, or null. */
  found: string | null;
  version: string | null;
  /** True, false, or null when the CLI would not say. */
  signedIn: boolean | null;
  /** What to run to sign in. */
  signInFix: string;
  /** Non-empty when the probe failed for a reason worth repeating. */
  problem: string;
}

/** Run something briefly and collect its output. Never throws. */
function capture(command: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const launcher = resolveLauncher(command);
    let child;
    try {
      child = spawn(launcher.command, [...launcher.prefix, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      return resolve({ ok: false, out: (err as Error).message });
    }

    let out = "";
    const take = (chunk: Buffer) => {
      out = (out + chunk.toString("utf8")).slice(-4000);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);

    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, out: `timed out after ${Math.round(timeoutMs / 1000)} s` });
    }, timeoutMs);

    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ ok: false, out: err.code === "ENOENT" ? "not found" : (err.message ?? "failed") });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out: out.trim() });
    });
  });
}

/**
 * The first thing that looks like a version, since these CLIs pad their output.
 *
 * No word boundary in front of the digits: `node --version` answers `v24.19.0`,
 * and `` does not match between `v` and `2` because both are word
 * characters. A leading boundary therefore reports every `v`-prefixed CLI as
 * missing — which is how this was found, by a test that pointed at Node.
 */
function versionFrom(text: string): string | null {
  const match = /\d+\.\d+\.\d+(?:[-+.\w]*)/.exec(text);
  return match ? match[0] : null;
}

export async function probe(backend: SetupTarget, label: string, command: string): Promise<CliStatus> {
  const found = resolveLauncher(command);
  // 25 s, not 5: a cold CLI on Windows can spend seconds before it prints its
  // own version, and calling a slow install "missing" is the worse mistake.
  const result = await capture(command, ["--version"], 25_000);
  const version = versionFrom(result.out);

  const auth = AUTH_PROBES[backend];
  let signedIn: boolean | null = null;
  if (version && auth) {
    const answer = await capture(command, auth.args, 25_000);
    signedIn = auth.reads(answer.out, answer.ok);
  }
  // Report the script, not the interpreter. An npm CLI resolves to
  // `node.exe <script>`, and answering "where is Gemini?" with the path to
  // Node is true and useless.
  const where = found.prefix.length > 0 ? found.prefix[found.prefix.length - 1] : found.command;

  return {
    backend,
    label,
    command,
    found: version ? where : null,
    version,
    signedIn,
    signInFix: auth?.fix ?? "",
    problem: version ? "" : result.out.slice(0, 200),
  };
}
