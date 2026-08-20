/**
 * Sub Models for Astra.
 *
 * Astra asks a provider for a completion. This plugin answers by driving an
 * agent CLI you already pay for — Claude Code on a Claude subscription, Codex
 * on a ChatGPT one — so the turn is billed against that plan instead of an API
 * key. Nothing here bypasses anything: both CLIs are official, both are signed
 * in by you, and this only speaks the documented print mode.
 *
 * The awkward join is tools. Astra wants a `toolCall` chunk back so it can run
 * the tool itself, with its own permissions and its own confirmation dialog. A
 * CLI wants to run the tool and return prose. `src/mcp-shim.ts` resolves it: the
 * tools are declared to the CLI over MCP but the shim never executes one, and
 * the call is caught in the output stream — where it appears before it runs —
 * and handed to Astra. The CLI is then killed, because it is waiting on a
 * result that is never coming.
 *
 * Every turn is written to a ledger and checked against the limits in the
 * settings first. A subscription does not bill you, it throttles you, and it
 * does so on a window you cannot see: the ledger is the window you can.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { plugin, tool, s, BadArguments, RateLimited, Unavailable, type AiCompleteRequest } from "astra-plugin-sdk";

import { readSettings, commandFor, defaultLedgerPath, type Settings } from "./config.js";
import * as budget from "./budget.js";
import { render, bridgeNotes } from "./transcript.js";
import { claudeBackend } from "./backends/claude.js";
import { codexBackend } from "./backends/codex.js";
import { normaliseEffort, type Backend, type Wiring } from "./backends/types.js";
import { run, CliMissing } from "./runner.js";
import { diagnose } from "./diagnose.js";
import {
  DEFAULT_COMMANDS,
  INSTALL_PLANS,
  LABELS,
  SETUP_TARGETS,
  probe,
} from "./setup.js";

const BACKENDS: Record<string, Backend> = { claude: claudeBackend, codex: codexBackend };

/**
 * Four characters to the token, which is wrong for every language and least
 * wrong for a mix. Only used when the CLI never got to report real usage —
 * i.e. when a tool call cut the turn short — so that a tool-heavy hour still
 * moves the ledger instead of registering as free.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * The model Astra put on the request, when it is worth anything.
 *
 * Astra's own Model box reaches a plugin as `req.model`, but its model *picker*
 * never does: the daemon builds every plugin provider with
 * `supports_model_discovery: false` and has no call site for `AiGetModels`, so
 * nothing ever asks this plugin what it can run. Checked on daemon 0.2.0 —
 * zero calls in a full day of logs. That is why the lists live in this
 * plugin's own settings; this function is only so the box upstairs is not
 * dead weight when they are all empty.
 *
 * A value with a slash in it is dropped. Astra's box is shaped for API model
 * ids like `openai/gpt-4o-mini`, and no agent CLI accepts that form — passing
 * one through would fail every turn with a message about a model nobody
 * deliberately chose.
 */
function modelFromRequest(req: AiCompleteRequest): string {
  const model = (req.model ?? "").trim();
  return model && !model.includes("/") ? model : "";
}

/** MCP wants a JSON Schema object; Astra ships one as a string. */
function toMcpTools(req: AiCompleteRequest): { name: string; description: string; inputSchema: unknown }[] {
  return req.tools.map((t) => {
    let schema: unknown = { type: "object", properties: {} };
    try {
      const parsed: unknown = JSON.parse(t.parametersJson || "{}");
      if (parsed && typeof parsed === "object") schema = parsed;
    } catch {
      /* a tool whose schema will not parse is still a tool worth offering */
    }
    return { name: t.name, description: t.description, inputSchema: schema };
  });
}

/**
 * Where `mcp-shim.js` ended up.
 *
 * Normally next door: both files are built into `dist/`. Not in the test
 * build, which puts the plugin in `.test-build/` and leaves the shim where it
 * was — and the first time that happened the tools did not fail, they simply
 * were not there, and the model politely explained it had no weather tool.
 * A path this load-bearing gets checked rather than assumed.
 */
function resolveShim(): string | null {
  const candidates = [
    path.join(__dirname, "mcp-shim.js"),
    path.join(__dirname, "..", "dist", "mcp-shim.js"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

interface Scratch {
  dir: string;
  /** `--mcp-config` for Claude, inline JSON for Codex, null when unused. */
  mcpConfig: string | null;
  /** Whatever `prepare` decided the process needs. */
  wiring: Wiring;
}

/**
 * The per-turn scratch directory, and everything written into it.
 *
 * Always made, even with no tools to offer: Gemini takes its system prompt
 * from a file and its configuration from the directory it runs in, so for that
 * backend the directory *is* half the invocation. It is removed in `finally`.
 */
function prepareTurn(backend: Backend, tools: unknown[], shim: string | null, system: string): Scratch {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astra-sub-"));

  let toolsFile: string | null = null;
  let mcpConfig: string | null = null;

  if (shim) {
    toolsFile = path.join(dir, "tools.json");
    fs.writeFileSync(toolsFile, JSON.stringify(tools), "utf8");

    const config = backend.mcpConfig(shim, toolsFile);
    // Claude reads a file, Codex takes the same object as `-c` overrides, and
    // Gemini reads neither — `prepare` writes it into a settings file instead.
    // The file is written for all three so a failed turn can be reproduced by
    // hand from what is on disk.
    const configFile = path.join(dir, "mcp.json");
    fs.writeFileSync(configFile, JSON.stringify(config), "utf8");
    mcpConfig = backend.id === "codex" ? JSON.stringify(config) : configFile;
  }

  const wiring = backend.prepare?.(dir, { shim: shim ?? "", toolsFile, system }) ?? {};
  return { dir, mcpConfig, wiring };
}

function statusReport(settings: Settings): string {
  const now = Date.now();
  const ledger = budget.prune(budget.loadLedger(settings.ledgerPath), now);
  const used = budget.measure(ledger, now);
  const cap = (n: number) => (n > 0 ? String(n) : "unlimited");
  const chosen = settings.models.find((m) => m.cli === settings.model);
  const model = chosen ? `${chosen.choice} — ${chosen.note}` : settings.model || "the CLI default";
  const offered = settings.models
    .filter((m) => m.cli !== "")
    .map((m) => m.choice)
    .join(", ");
  return [
    `Backend: ${BACKENDS[settings.backend]?.label ?? settings.backend}, on ${model}`,
    offered ? `Also available: ${offered} — change it in this plugin's settings.` : "",
    `Turns this hour: ${used.turnsHour}/${cap(settings.turnsPerHour)}`,
    `Turns today: ${used.turnsDay}/${cap(settings.turnsPerDay)}`,
    `Tokens today: ${used.tokensDay}/${cap(settings.tokensPerDay)}`,
    "Astra's own Model box is only used when all of those are empty, and never for a name with a slash in it.",
    `When a limit is reached: ${settings.onLimit === "warn" ? "warn and continue" : "refuse the turn"}`,
    `Ledger: ${settings.ledgerPath}`,
  ].join("\n");
}

export const app = plugin({
  configSchema: s.object({
    backend: s.string().optional(),
    claude_command: s.string().optional(),
    codex_command: s.string().optional(),
    claude_model: s.string().optional(),
    codex_model: s.string().optional(),
    model_override: s.string().optional(),
    model: s.string().optional(),
    reasoning: s.string().optional(),
    turns_per_hour: s.number().optional(),
    turns_per_day: s.number().optional(),
    tokens_per_day: s.number().optional(),
    on_limit: s.string().optional(),
    turn_timeout_secs: s.number().optional(),
    pass_tools: s.boolean().optional(),
    extra_args: s.string().optional(),
    ledger_path: s.string().optional(),
  }),

  tools: {
    // Deliberately the only tool. This plugin is normally *the model*, so
    // anything it registers is a tool the model then sees in its own
    // catalogue — a cost worth paying exactly once, for the question the
    // settings page cannot answer: how much is left.
    // The wall every new user hits: nothing installed, or nothing signed in.
    // Reporting it is all this does. Installing was tried and taken back out —
    // see README's setup section, and `src/setup.ts` for why the settings page
    // is the wrong place to put a verb.
    subscription_setup: tool({
      description:
        "Report which of the Claude Code, Codex, Gemini and Antigravity CLIs are installed, with their versions and paths, and how to install any that are missing. Use this when Astra reports that a CLI is missing, or when the user asks what is set up.",
      input: s.object({
        cli: s
          .string()
          .optional()
          .describe("Which CLI to check: claude, codex, gemini or antigravity. Omit to check all of them."),
      }),
      run: async (args, ctx) => {
        const wanted = (args.cli ?? "").trim().toLowerCase();
        const only = SETUP_TARGETS.find((t) => t === wanted);
        const targets = only ? [only] : SETUP_TARGETS;

        const rows = await Promise.all(
          targets.map((t) => probe(t, LABELS[t], commandFor(ctx.config, t) || DEFAULT_COMMANDS[t])),
        );
        const lines = rows.map((row) => {
          if (!row.version) {
            const plan = INSTALL_PLANS[row.backend];
            const how =
              plan.kind === "npm" ? `install it with: npm i -g ${plan.packageName}` : `download it from ${plan.url}`;
            return `${row.label}: NOT INSTALLED — ${how}${row.problem ? ` (${row.problem})` : ""}`;
          }
          // Installed and usable are different states, and reporting only the
          // first sends people to debug the wrong thing.
          const auth =
            row.signedIn === true
              ? "signed in"
              : row.signedIn === false
                ? `NOT SIGNED IN — ${row.signInFix}`
                : "sign-in state unknown";
          return `${row.label}: installed ${row.version}, ${auth} (${row.found})`;
        });
        lines.push(
          "",
          "Signing in is done in a terminal: the CLI opens a browser against your own account. This plugin never handles credentials.",
        );
        return lines.join("\n");
      },
    }),

    subscription_status: tool({
      description:
        "Report which subscription backend Astra is running on and how much of the configured turn and token budget is left today.",
      input: s.object({}),
      run: (_args, ctx) => statusReport(readSettings(ctx.config)),
    }),
  },

  ai: {
    async *complete(req, ctx) {
      const settings = readSettings(ctx.config);
      const backend = BACKENDS[settings.backend];
      if (!backend) throw new Unavailable({ message: `Unknown backend '${settings.backend}'.` });

      const startedAt = Date.now();
      const ledger = budget.prune(budget.loadLedger(settings.ledgerPath), startedAt);
      const verdict = budget.check(settings, ledger, startedAt);
      if (verdict.warning) await ctx.warn(`Approaching a limit — ${verdict.warning}`);
      if (!verdict.allowed) {
        // A thrown error, not a spoken one: the assistant saying "I have run
        // out of budget" reads as the model's opinion. This is the plugin's.
        throw new RateLimited({
          message: verdict.reason ?? "Usage limit reached.",
          retryAfterMs: verdict.retryAfterMs,
          configField: "turns_per_hour",
        });
      }

      const shim = settings.passTools && req.tools.length > 0 ? resolveShim() : null;
      if (settings.passTools && req.tools.length > 0 && !shim) {
        // Loud, because the alternative is a model that quietly answers "I
        // have no tools" and an hour spent wondering why.
        await ctx.error("mcp-shim.js is missing from the plugin directory — this turn runs without tools.");
      }
      // Order of precedence, most specific first: the override box, the
      // backend's own dropdown, then whatever Astra was told upstairs.
      let model = settings.model;
      if (!model) {
        model = modelFromRequest(req);
        if (model) await ctx.info(`Using the model from Astra's own settings: ${model}`);
      }

      const wantsTools = shim !== null;
      const { system, prompt } = render(req, bridgeNotes(wantsTools));
      const scratch = prepareTurn(backend, toMcpTools(req), shim, system);

      const built = backend.build({
        system,
        prompt,
        model,
        // The setting wins when set; otherwise follow whatever Astra asked
        // for on the request, which is the user's choice one screen over.
        effort: normaliseEffort(settings.reasoning || req.reasoningEffort || ""),
        mcpConfigFile: scratch.mcpConfig,
        extraArgs: settings.extraArgs,
      });
      const spec = { ...built, cwd: scratch.wiring.cwd ?? built.cwd, env: scratch.wiring.env ?? built.env };

      let tokens = 0;
      let sawUsage = false;
      let sawAnything = false;

      try {
        for await (const event of run(settings.command, spec, backend, settings.turnTimeoutSecs * 1000)) {
          switch (event.kind) {
            case "text":
              sawAnything = true;
              yield { text: event.text };
              break;

            case "thinking":
              // `showReasoning` is the user's choice about their own screen;
              // the tokens are already spent either way.
              if (req.showReasoning) yield { thinking: event.text };
              break;

            case "toolCall":
              sawAnything = true;
              yield { toolCall: { id: event.id, name: event.name, argumentsJson: event.argumentsJson } };
              // Returning here is what kills the CLI: it is blocked on a shim
              // that will never answer, and Astra now owns the call. The next
              // turn arrives as a fresh request with the result in `messages`.
              tokens = estimateTokens(system + prompt);
              return;

            case "usage":
              sawUsage = true;
              tokens = event.tokens;
              break;

            case "rateLimit":
              // The provider's own throttle. Worth a log line even when the
              // turn succeeds — it is the early warning our ledger cannot give.
              await ctx.warn(`${backend.label} reports a rate limit: ${event.detail}`);
              break;

            case "error": {
              const known = diagnose(backend.label, event.message);
              throw new Unavailable({ message: known ? known.message : event.message });
            }
          }
        }

        if (!sawAnything) {
          throw new Unavailable({
            message:
              `${backend.label} produced no output. Check that it is signed in: ` +
              `run '${settings.command} -p hello' in a terminal.`,
          });
        }
      } catch (err) {
        if (err instanceof CliMissing) throw new Unavailable({ message: err.message });
        // A turn that failed because nobody is signed in is not an internal
        // error, and reporting it as one — with a stack trace attached — sends
        // the user to debug the plugin instead of their account.
        const known = err instanceof Error ? diagnose(backend.label, err.message) : null;
        if (known) throw new Unavailable({ message: known.message });
        throw err;
      } finally {
        fs.rmSync(scratch.dir, { recursive: true, force: true });
        if (!sawUsage && tokens === 0) tokens = estimateTokens(system + prompt);
        budget.saveLedger(settings.ledgerPath, budget.record(ledger, startedAt, tokens));
      }
    },
  },

  async onStart(ctx) {
    const settings = readSettings(ctx.config);
    const label = BACKENDS[settings.backend]?.label ?? settings.backend;
    await ctx.info(`Starting on ${label} via '${settings.command}'. Ledger at ${settings.ledgerPath}.`);

    // Check now rather than on the first turn. A missing or unauthenticated
    // CLI is a wall the user hits at the worst moment otherwise —
    // mid-conversation, with the provider already switched and nothing able to
    // answer. Both questions are answered for free: `--version` for the first,
    // and each CLI's own status command for the second.
    const status = await probe(settings.backend, label, settings.command);
    const plan = INSTALL_PLANS[settings.backend];
    const howToInstall = plan.kind === "npm" ? `npm i -g ${plan.packageName}` : `download it from ${plan.url}`;

    if (!status.version) {
      await ctx.error(
        `${label} is NOT INSTALLED ('${settings.command}': ${status.problem || "not found"}). ` +
          `Astra will fail every turn on this provider. Install it with: ${howToInstall}, then sign in. ` +
          `— По-русски: ${label} НЕ УСТАНОВЛЕН. Астра будет падать на каждом запросе с этим провайдером. ` +
          `Установите: ${howToInstall}, затем войдите в аккаунт.`,
      );
      return;
    }

    if (status.signedIn === false) {
      await ctx.error(
        `${label} ${status.version} is installed but YOU ARE NOT SIGNED IN. ` +
          `Astra will fail every turn until you are. Run '${status.signInFix}' in a terminal — ` +
          `it opens a browser against your own account, and this plugin never sees the credentials. ` +
          `— По-русски: ${label} установлен, но ВЫ НЕ АВТОРИЗОВАНЫ. До входа каждый запрос будет падать. ` +
          `Запустите '${status.signInFix}' в терминале: откроется браузер с вашим аккаунтом, ` +
          `плагин учётных данных не видит.`,
      );
      return;
    }

    if (status.signedIn === null) {
      await ctx.warn(
        `${label} ${status.version} found at ${status.found}, but it would not say whether you are signed in. ` +
          `If turns fail with an authentication error: ${status.signInFix}. ` +
          `— По-русски: ${label} найден, но сообщить о состоянии входа отказался. ` +
          `Если запросы падают с ошибкой авторизации: ${status.signInFix}.`,
      );
      return;
    }

    await ctx.info(
      `${label} ${status.version} found at ${status.found}, signed in. Ready. ` +
        `— По-русски: ${label} найден и авторизован. Готов.`,
    );
  },
});

export { defaultLedgerPath };

if (require.main === module) app.run();
