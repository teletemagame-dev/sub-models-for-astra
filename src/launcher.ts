/**
 * Turning a command name into something Node will actually spawn.
 *
 * Two of the three CLIs this plugin drives install through npm, and on Windows
 * an npm binary is a `.cmd` shim rather than an executable. Node has refused to
 * spawn `.cmd` and `.bat` without `shell: true` since 18.20 — the fix for
 * CVE-2024-27980 — so `spawn("gemini", …)` throws EINVAL and `spawn("gemini")`
 * without the extension is ENOENT. Measured, not assumed: both happen on this
 * machine with gemini-cli 0.56.0 installed globally.
 *
 * The obvious workaround is `shell: true`, and it is the wrong one. The
 * arguments carry Astra's system prompt — arbitrary text, some of it written by
 * whoever is talking to Astra — and handing that to `cmd.exe` makes `&`, `|`,
 * `^` and `%VAR%` meaningful. A prompt is not a command line.
 *
 * So instead: read the shim. npm writes a predictable one that ends in
 *
 *     "%_prog%"  "%dp0%\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js" %*
 *
 * and the path in it is the script the shim would have run. Running that under
 * this same Node is the same work with none of the quoting.
 */

import fs from "node:fs";
import path from "node:path";

export interface Launcher {
  command: string;
  /** Goes in front of the backend's own arguments. */
  prefix: string[];
}

/**
 * Extensions Windows will run, in the order to try them.
 *
 * The empty one is LAST, and that ordering is the whole point: npm writes
 * three files per binary — `gemini`, `gemini.cmd`, `gemini.ps1` — and the
 * extensionless one is a shell script for Git Bash and WSL. Windows cannot
 * execute it, so finding it first means resolving a working install to a file
 * that spawns ENOENT. PATHEXT is what Windows itself consults, and it does
 * not contain the empty string.
 */
const WINDOWS_EXTENSIONS = [".exe", ".com", ".cmd", ".bat", ""];

const SHIM_EXTENSIONS = new Set([".cmd", ".bat"]);

/**
 * Where these CLIs live when PATH does not say so.
 *
 * A process inherits the environment it was started with, and Astra's daemon
 * may well have been started before the CLI was installed — which is exactly
 * how "it works in my terminal but not in Astra" happens. These are the two
 * directories the three supported CLIs actually install into, derived from the
 * environment rather than hardcoded, and consulted only after PATH has failed.
 */
function fallbackDirectories(): string[] {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const appData = process.env.APPDATA ?? (home ? path.join(home, "AppData", "Roaming") : "");
  return [
    // npm's global prefix on Windows — Gemini CLI and Codex.
    appData ? path.join(appData, "npm") : "",
    // npm's default elsewhere, and where Claude Code's installer puts itself.
    home ? path.join(home, ".local", "bin") : "",
    home ? path.join(home, ".npm-global", "bin") : "",
  ].filter(Boolean);
}

/** Walk PATH the way the shell would, since we are not using one. */
function findOnPath(command: string): string | null {
  if (command.includes("/") || command.includes("\\")) {
    return fs.existsSync(command) ? command : withExtension(command);
  }
  const directories = [...(process.env.PATH ?? "").split(path.delimiter), ...fallbackDirectories()];
  for (const dir of directories) {
    if (!dir) continue;
    const found = withExtension(path.join(dir, command));
    if (found) return found;
  }
  return null;
}

function withExtension(base: string): string | null {
  const extensions = process.platform === "win32" ? WINDOWS_EXTENSIONS : [""];
  for (const extension of extensions) {
    const candidate = base + extension;
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* not there, try the next */
    }
  }
  return null;
}

/** The `.js` an npm shim would have run, or null if this is not one. */
function scriptBehindShim(shim: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(shim, "utf8");
  } catch {
    return null;
  }

  // Two shapes in the wild, and npm writes both. A package binary inlines the
  // path in the final line:
  //
  //     "%_prog%"  "%dp0%\\node_modules\\pkg\\cli.js" %*
  //
  // while npm's own shim assigns it first, with a tilde:
  //
  //     SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"
  //     "%NODE_EXE%" "%NPM_CLI_JS%" %*
  //
  // So match the directory token anywhere rather than only after a quote, and
  // take the LAST candidate that is really on disk: a shim's final line is its
  // invocation, so later matches sit closer to what actually runs. npm's own
  // names npm-prefix.js before npm-cli.js, and only the second one is the CLI.
  const pattern = /%~?dp0%?[\\/]*([^"\r\n]+?\.(?:js|mjs|cjs))/gi;
  const directory = path.dirname(shim);

  let script: string | null = null;
  for (const match of text.matchAll(pattern)) {
    const candidate = path.join(directory, match[1].replace(/[\\/]+/g, path.sep));
    if (fs.existsSync(candidate)) script = candidate;
  }
  return script;
}

/**
 * How to run `command`.
 *
 * Falls back to handing the name straight to `spawn` whenever anything is
 * unclear — a command we failed to find may still be one the OS can resolve,
 * and the runner already reports a missing binary in words the user can act on.
 */
export function resolveLauncher(command: string): Launcher {
  if (process.platform !== "win32") return { command, prefix: [] };

  const found = findOnPath(command);
  if (!found) return { command, prefix: [] };
  if (!SHIM_EXTENSIONS.has(path.extname(found).toLowerCase())) return { command: found, prefix: [] };

  const script = scriptBehindShim(found);
  // A shim we cannot read is still better attempted than not: the spawn will
  // fail with EINVAL, which the runner explains.
  return script ? { command: process.execPath, prefix: [script] } : { command: found, prefix: [] };
}
