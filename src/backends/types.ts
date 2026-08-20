/**
 * What every backend reduces to.
 *
 * The two CLIs this plugin drives disagree about almost everything — flag
 * names, event shapes, how a tool is declared — but they agree on the only
 * thing that matters here: a process that reads a prompt and writes a stream
 * of events. A backend is the translation of one CLI's stream into this one.
 */

export type BackendEvent =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "toolCall"; id: string; name: string; argumentsJson: string }
  /** Reported once, at the end, when the CLI says what the turn cost. */
  | { kind: "usage"; tokens: number; costUsd: number }
  /** The provider's own throttle, straight from the API — not our ledger. */
  | { kind: "rateLimit"; detail: string }
  | { kind: "error"; message: string };

export interface LaunchSpec {
  /** Command line, after the executable. */
  args: string[];
  /** Written to stdin, then closed. */
  stdin: string;
  /** Where to run. Set when a CLI takes its configuration from the directory. */
  cwd?: string;
  /** Added to the environment. Set when a CLI takes settings that way. */
  env?: Record<string, string>;
}

/** What `prepare` hands back for `build` and the runner to use. */
export interface Wiring {
  cwd?: string;
  env?: Record<string, string>;
}

export interface Backend {
  readonly id: string;
  /** Human name for error messages. */
  readonly label: string;
  /** How to check the CLI is there and logged in. */
  readonly versionArgs: string[];
  /**
   * Path of the MCP config this backend understands, given a tool manifest,
   * or null when the backend cannot take tools this way.
   */
  mcpConfig(shimPath: string, toolsFile: string): unknown | null;
  /**
   * Write whatever the CLI reads from disk rather than from its command line,
   * and say where to run and with what environment.
   *
   * Only Gemini implements it: its MCP servers and tool allowlist come from a
   * `settings.json` in the working directory, and its system prompt from a
   * file named by an environment variable. There is no flag for either, so the
   * scratch directory *is* the configuration.
   */
  prepare?(dir: string, opts: { shim: string; toolsFile: string | null; system: string }): Wiring;
  build(opts: {
    system: string;
    prompt: string;
    model: string;
    /** One of low/medium/high/xhigh/max, or "" to let the CLI decide. */
    effort: string;
    mcpConfigFile: string | null;
    extraArgs: string[];
  }): LaunchSpec;
  /** True when `system` reaches the CLI some way other than the prompt or a flag. */
  readonly systemViaPrepare?: boolean;
  /** One line of stdout → zero or more events. Must never throw. */
  parseLine(line: string, state: ParseState): BackendEvent[];
}

/** Carried across lines of one run. */
export interface ParseState {
  sawTextDelta: boolean;
}

export function newParseState(): ParseState {
  return { sawTextDelta: false };
}

/** MCP names a tool `mcp__<server>__<tool>`; Astra only knows the last part. */
export const MCP_SERVER = "astra";

export function stripMcpPrefix(name: string): string {
  // Claude Code writes `mcp__astra__tool`. Gemini's shape was not observed, so
  // the bare `astra__tool` form is stripped too: guessing wrong here costs a
  // tool call Astra cannot match, and the cost of accepting both is nothing.
  for (const prefix of [`mcp__${MCP_SERVER}__`, `${MCP_SERVER}__`]) {
    if (name.startsWith(prefix)) return name.slice(prefix.length);
  }
  return name;
}

/**
 * Astra's `reasoning_effort` vocabulary is wider than either CLI's.
 *
 * `""` means the daemon did not say and `"auto"` means the user chose to let
 * something else decide — both are "pass nothing". `"off"` has no rung on
 * either CLI's scale, and mapping it to `low` would be inventing a decision
 * the user did not make, so it also passes nothing.
 */
const CLI_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export function normaliseEffort(value: string): string {
  return CLI_EFFORTS.includes(value) ? value : "";
}
