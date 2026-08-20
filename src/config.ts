/**
 * The settings page, read once per turn.
 *
 * Every value here is something the user typed into a box that the daemon
 * hands over as `Record<string, unknown>` — not as the schema promised it.
 * A plugin that trusts the shape crashes on the first person who clears a
 * field, so everything below coerces and clamps rather than asserts.
 */

import os from "node:os";
import path from "node:path";

export type BackendId = "claude" | "codex";
export type LimitAction = "refuse" | "warn";

export interface Settings {
  backend: BackendId;
  /** The executable to spawn for the chosen backend. */
  command: string;
  /** Model name passed to the CLI. Empty means "whatever the CLI defaults to". */
  model: string;
  /** Every model the chosen backend offers, for the status report. */
  models: readonly ModelChoice[];
  /** `""` follows whatever Astra asked for on the request. */
  reasoning: string;
  /** 0 disables the limit — every one of them. */
  turnsPerHour: number;
  turnsPerDay: number;
  tokensPerDay: number;
  onLimit: LimitAction;
  turnTimeoutSecs: number;
  /** Hand Astra's tool catalogue to the CLI so the model can call them. */
  passTools: boolean;
  /** Split on whitespace; appended to the command line verbatim. */
  extraArgs: string[];
  /** Where the usage ledger lives. Outside the plugin dir so a reinstall keeps it. */
  ledgerPath: string;
}

/**
 * One entry in a model dropdown.
 *
 * `choice` is both what the settings page shows and what it stores, and those
 * being the same thing is not a design decision — Astra renders a JSON Schema
 * `enum` by printing each value, with no way to attach a label. `enumNames`
 * exists in the daemon but belongs to its MCP elicitation support, not to the
 * plugin settings form. So a dropdown of `sonnet` / `fable` / `opus` is what
 * raw model ids look like to a reader, and the fix is to make the values
 * readable and translate them back here.
 */
export interface ModelChoice {
  /** Shown in the dropdown and written to the config. */
  choice: string;
  /** What actually goes to the CLI. Empty means "say nothing". */
  cli: string;
  /** One line for `subscription_status`. */
  note: string;
}

const DEFAULT_CHOICE = "Default";

/**
 * Claude Code's models, checked against a live subscription on 2026-08-19.
 *
 * The context sizes are read off each model's own `modelUsage` report. Opus 5's
 * is the one that changes a decision: 200K where every other entry has 1M, and
 * this plugin replays the whole conversation every turn, so that ceiling
 * arrives sooner here than it would in a chat app.
 *
 * `Opus 4.8` is kept because the bare `opus` alias still resolves to it, and
 * because a fifth of a context window is a real reason to prefer it.
 */
export const CLAUDE_MODELS: readonly ModelChoice[] = [
  { choice: DEFAULT_CHOICE, cli: "", note: "whatever Claude Code is set to" },
  // A full name, not an alias: `opus` points at 4.8, and `opus-5` is not an
  // alias at all — the CLI answers it with a synthetic "may not exist" turn.
  { choice: "Opus 5", cli: "claude-opus-5", note: "strongest reasoning, 200K context" },
  { choice: "Fable 5", cli: "fable", note: "newest, 1M context" },
  { choice: "Sonnet 5", cli: "sonnet", note: "the everyday one, 1M context" },
  { choice: "Haiku 4.5", cli: "haiku", note: "fastest and cheapest, 200K context" },
  { choice: "Opus 4.8", cli: "opus", note: "previous Opus, 1M context" },
];

/**
 * Codex, as of August 2026. GPT-5.4 and 5.4-mini are deliberately absent:
 * they retire on 31 August 2026, and an entry that stops resolving is worse
 * than one that was never offered.
 */
export const CODEX_MODELS: readonly ModelChoice[] = [
  { choice: DEFAULT_CHOICE, cli: "", note: "whatever Codex is set to" },
  { choice: "GPT-5.6 Sol", cli: "gpt-5.6-sol", note: "deep-reasoning flagship" },
  { choice: "GPT-5.6 Terra", cli: "gpt-5.6-terra", note: "balanced, the sensible default" },
  { choice: "GPT-5.6 Luna", cli: "gpt-5.6-luna", note: "fast and cheap" },
  { choice: "GPT-5.5", cli: "gpt-5.5", note: "previous frontier model" },
  { choice: "GPT-5.3 Codex Spark", cli: "gpt-5.3-codex-spark", note: "lowest latency, ChatGPT Pro only" },
];


/**
 * Turn whatever is stored into what the CLI is given.
 *
 * Three things have to work. A display name from the dropdown, obviously. A
 * raw model id, because that is what earlier versions of this plugin stored
 * and what anybody typing into the override box will use. And anything else,
 * passed through untouched — a model released after this build should not need
 * a plugin release to reach.
 */
export function resolveModel(models: readonly ModelChoice[], stored: string): string {
  const wanted = stored.trim();
  if (!wanted || wanted.toLowerCase() === DEFAULT_CHOICE.toLowerCase()) return "";
  const match = models.find(
    (m) => m.choice.toLowerCase() === wanted.toLowerCase() || m.cli.toLowerCase() === wanted.toLowerCase(),
  );
  return match ? match.cli : wanted;
}

const BACKENDS: readonly BackendId[] = ["claude", "codex"];
const EFFORTS = ["", "auto", "off", "low", "medium", "high", "max"];

function str(config: Record<string, unknown>, key: string, fallback: string): string {
  const raw = config[key];
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  return trimmed === "" ? fallback : trimmed;
}

function bool(config: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const raw = config[key];
  if (typeof raw === "boolean") return raw;
  // The daemon has delivered "true"/"false" as strings before now.
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
}

/** Non-negative integer, or the fallback. Never NaN, never negative, never a float. */
function count(config: Record<string, unknown>, key: string, fallback: number): number {
  const raw = config[key];
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

export function defaultLedgerPath(): string {
  return path.join(os.homedir(), ".astra-sub-models", "usage.json");
}

/**
 * The command box for one CLI, whether or not it is the active backend.
 *
 * `readSettings` only ever resolves the backend in use; setup has to look at
 * all of them at once, including Antigravity, which has no backend to be.
 */
export function commandFor(config: Record<string, unknown>, target: string): string {
  switch (target) {
    case "codex":
      return str(config, "codex_command", "codex");
    default:
      return str(config, "claude_command", "claude");
  }
}

export function readSettings(config: Record<string, unknown>): Settings {
  const backend = BACKENDS.includes(config.backend as BackendId)
    ? (config.backend as BackendId)
    : "claude";

  // One box per backend, because the two are rarely both on PATH under the
  // same name and asking the user to retype the path when they switch is the
  // kind of small cruelty that makes a settings page feel hostile.
  const command =
    backend === "claude" ? str(config, "claude_command", "claude") : str(config, "codex_command", "codex");

  // Per-backend, the same way the command is: switching backends should not
  // silently hand Codex a model name that only Claude Code understands.
  // `model` is the field this plugin shipped with before the lists existed;
  // it still answers so that an upgrade does not quietly reset the choice.
  const legacy = str(config, "model", "");
  const listed =
    backend === "claude" ? str(config, "claude_model", legacy) : str(config, "codex_model", legacy);
  // The escape hatch, and it wins. Every list here will go stale — OpenAI is
  // retiring two names this month — and a dropdown with no way past it turns
  // a rename into "wait for a plugin release".
  const chosen = str(config, "model_override", listed);
  const models = backend === "claude" ? CLAUDE_MODELS : CODEX_MODELS;
  const model = resolveModel(models, chosen);

  const reasoning = str(config, "reasoning", "");

  return {
    backend,
    command,
    model,
    models,
    reasoning: EFFORTS.includes(reasoning) ? reasoning : "",
    turnsPerHour: count(config, "turns_per_hour", 60),
    turnsPerDay: count(config, "turns_per_day", 400),
    tokensPerDay: count(config, "tokens_per_day", 0),
    onLimit: config.on_limit === "warn" ? "warn" : "refuse",
    // A turn that runs longer than this is a turn nobody is still waiting for.
    turnTimeoutSecs: Math.max(10, count(config, "turn_timeout_secs", 180)),
    passTools: bool(config, "pass_tools", true),
    extraArgs: str(config, "extra_args", "").split(/\s+/).filter(Boolean),
    ledgerPath: str(config, "ledger_path", defaultLedgerPath()),
  };
}
