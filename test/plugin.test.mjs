/**
 * Tests for Sub Models for Astra.
 *
 * None of these need a subscription, a network, or either CLI installed. The
 * two things that genuinely cannot be faked — that Claude Code accepts these
 * flags, and that it calls a tool the shim declares — were measured once by
 * hand and are recorded in `README.md`; everything downstream of them is here.
 *
 * `test/fake-cli.mjs` stands in for the CLI, replaying lines captured from a
 * real run. Run: `npm test`.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

const {
  app,
  budget,
  readSettings,
  resolveModel,
  CLAUDE_MODELS,
  render,
  bridgeNotes,
  claudeBackend,
  codexBackend,
  newParseState,
  normaliseEffort,
  run,
  CliMissing,
  resolveLauncher,
  diagnose,
  readable,
  INSTALL_PLANS,
  probe,
} = require("../.test-build/plugin.cjs");
const { Harness } = require("astra-plugin-sdk/testing");

const FAKE_CLI = path.join(here, "fake-cli.mjs");
const SHIM = path.join(here, "..", "dist", "mcp-shim.js");

/** A ledger nobody else is using, deleted when the test ends. */
function scratchLedger(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astra-sub-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "usage.json");
}

// ── the plugin as the daemon sees it ────────────────────────────────────────

test("the plugin starts, and answers a health check", async () => {
  const h = await Harness.create(app).start();
  assert.equal((await h.healthCheck()).healthy, true);
});

test("no config the daemon can deliver crashes this plugin", async () => {
  const h = await Harness.create(app).start();
  assert.deepEqual(await h.fuzzConfig(), []);
});

test("a missing CLI is reported as something the user can act on", async (t) => {
  const h = await Harness.create(app)
    .withConfig({ claude_command: "definitely-not-a-real-binary-9f3a", ledger_path: scratchLedger(t) })
    .start();

  const { chunks } = await h.aiComplete({ messages: [{ role: "user", content: "hi" }], tools: [] });
  const error = chunks.find((c) => c.error)?.error ?? "";
  assert.match(error, /not installed|not on PATH/i);
  // The name of the thing to install, not just "spawn ENOENT".
  assert.match(error, /Claude Code/);
});

test("a spent limit stops the turn before any CLI is started", async (t) => {
  const file = scratchLedger(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ turns: [{ at: Date.now(), tokens: 10 }, { at: Date.now(), tokens: 10 }] }));

  const h = await Harness.create(app)
    .withConfig({
      turns_per_hour: 2,
      // If the limit failed to bite, this command would be reached and the
      // error would name a missing binary instead of the limit.
      claude_command: "definitely-not-a-real-binary-9f3a",
      ledger_path: file,
    })
    .start();

  const { chunks } = await h.aiComplete({ messages: [{ role: "user", content: "hi" }], tools: [] });
  const error = chunks.find((c) => c.error)?.error ?? "";
  assert.match(error, /Hourly turn limit reached \(2\)/);
  assert.doesNotMatch(error, /not installed/, "the CLI must never have been spawned");
});

test("warn mode spends the turn anyway, which is what it promises", async (t) => {
  const file = scratchLedger(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ turns: [{ at: Date.now(), tokens: 10 }] }));

  const h = await Harness.create(app)
    .withConfig({ turns_per_hour: 1, on_limit: "warn", claude_command: "definitely-not-a-real-binary-9f3a", ledger_path: file })
    .start();

  const { chunks } = await h.aiComplete({ messages: [{ role: "user", content: "hi" }], tools: [] });
  // It got past the limit and died on the missing binary instead — which is
  // the proof that the limit let it through.
  assert.match(chunks.find((c) => c.error)?.error ?? "", /not installed|not on PATH/);
});

test("a refused turn is still written down, so limits cannot be reset by failing", async (t) => {
  const file = scratchLedger(t);
  const h = await Harness.create(app)
    .withConfig({ turns_per_hour: 0, claude_command: "definitely-not-a-real-binary-9f3a", ledger_path: file })
    .start();

  await h.aiComplete({ messages: [{ role: "user", content: "hi" }], tools: [] });
  assert.equal(budget.loadLedger(file).turns.length, 1, "a turn that failed still cost the attempt");
});

test("installed and signed in are reported as different states", async (t) => {
  // "Installed" and "usable" are not the same, and a report that conflates
  // them sends the user to debug the wrong thing. Every one of these CLIs has
  // a free way to answer the second question; this checks the one that is
  // certainly on this machine.
  const h = await Harness.create(app).withConfig({ ledger_path: scratchLedger(t) }).start();
  const result = await h.callTool("subscription_setup", { cli: "claude" });
  assert.equal(result.success, true);
  assert.match(result.result, /Claude Code: installed \d+\.\d+\.\d+, (signed in|NOT SIGNED IN|sign-in state unknown)/);
});

test("the one tool reports the budget without spawning anything", async (t) => {
  const h = await Harness.create(app)
    .withConfig({ backend: "claude", turns_per_day: 400, ledger_path: scratchLedger(t) })
    .start();

  const result = await h.callTool("subscription_status", {});
  assert.equal(result.success, true);
  assert.match(result.result, /Claude Code/);
  assert.match(result.result, /Turns today: 0\/400/);
  assert.match(result.result, /Tokens today: 0\/unlimited/);
  // The settings page is one screen away; the chat is not.
  assert.match(result.result, /Also available: Opus 5, Fable 5, Sonnet 5, Haiku 4\.5, Opus 4\.8/);
});

test("the status report names the model in words, not just its alias", async (t) => {
  const h = await Harness.create(app)
    .withConfig({ backend: "claude", claude_model: "opus", ledger_path: scratchLedger(t) })
    .start();
  const result = await h.callTool("subscription_status", {});
  assert.match(result.result, /on Opus 4\.8 — previous Opus/);
});

test("the CLI's own error prose is not put in the model's mouth", () => {
  // A bad --model comes back as an assistant turn from `<synthetic>` reading
  // "There's an issue with the selected model". Yielding it would show the
  // error as an answer and then throw a second one when `result` arrives.
  const synthetic = {
    type: "assistant",
    message: { model: "<synthetic>", content: [{ type: "text", text: "There's an issue with the selected model (opus-5)." }] },
  };
  assert.deepEqual(claudeBackend.parseLine(JSON.stringify(synthetic), newParseState()), []);

  // And the failure still surfaces, once, from the result line.
  const failed = { type: "result", subtype: "error_during_execution", is_error: true, result: "There's an issue with the selected model (opus-5).", usage: {} };
  const events = claudeBackend.parseLine(JSON.stringify(failed), newParseState());
  assert.equal(events.filter((e) => e.kind === "error").length, 1);
  assert.match(events.find((e) => e.kind === "error").message, /issue with the selected model/);
});

// ── the settings page itself ────────────────────────────────────────────────

/** The manifest is what Astra renders; the code only has to agree with it. */
function manifestSchema() {
  const toml = fs.readFileSync(path.join(here, "..", "plugin.toml"), "utf8");
  return JSON.parse(/schema = """([\s\S]*?)"""/.exec(toml)[1]);
}

test("the manifest and the code offer the same models", () => {
  const props = manifestSchema().properties;
  for (const [field, backend] of [["claude_model", "claude"], ["codex_model", "codex"]]) {
    assert.deepEqual(
      props[field].enum,
      readSettings({ backend }).models.map((m) => m.choice),
      `${field} in plugin.toml has drifted from the list the plugin reports`,
    );
    assert.equal(props[field].default, "Default", "the default must be a value the enum contains");
  }
});

test("every model offered is also explained, by name and by id", () => {
  // Astra prints the raw enum value with no way to attach a label, so the
  // values are the readable names and the description is the only prose there
  // is. It has to carry both: the name, so the row means something, and the
  // model id, so anyone comparing against a vendor's page can find it.
  const props = manifestSchema().properties;
  for (const [field, backend] of [["claude_model", "claude"], ["codex_model", "codex"]]) {
    const description = props[field].description;
    for (const model of readSettings({ backend }).models) {
      assert.ok(description.includes(model.choice), `${field}: ${model.choice} is offered but never described`);
      if (model.cli) {
        assert.ok(description.includes(model.cli), `${field}: ${model.choice} never names its model id`);
      }
    }
  }
});

test("a readable choice reaches the CLI as the id it means", () => {
  assert.equal(resolveModel(CLAUDE_MODELS, "Sonnet 5"), "sonnet");
  assert.equal(resolveModel(CLAUDE_MODELS, "Opus 5"), "claude-opus-5");
  assert.equal(resolveModel(CLAUDE_MODELS, "opus 4.8"), "opus", "matching is case-insensitive");
  // "Default" is a word in a dropdown, not a model.
  assert.equal(resolveModel(CLAUDE_MODELS, "Default"), "");
  assert.equal(resolveModel(CLAUDE_MODELS, ""), "");
  // What earlier versions of this plugin stored, and what anyone types into
  // the override box.
  assert.equal(resolveModel(CLAUDE_MODELS, "sonnet"), "sonnet");
  assert.equal(resolveModel(CLAUDE_MODELS, "claude-opus-5"), "claude-opus-5");
  // A model released after this build must not need a plugin release.
  assert.equal(resolveModel(CLAUDE_MODELS, "claude-opus-6"), "claude-opus-6");
});

test("the settings resolve a picked name all the way to the command line", () => {
  assert.equal(readSettings({ backend: "claude", claude_model: "Haiku 4.5" }).model, "haiku");
  assert.equal(readSettings({ backend: "codex", codex_model: "GPT-5.6 Terra" }).model, "gpt-5.6-terra");
  // Upgrading from a version that stored raw ids must not reset the choice.
  assert.equal(readSettings({ backend: "claude", claude_model: "sonnet" }).model, "sonnet");
});

test("the measured context sizes reach the user, not just the source", () => {
  const description = manifestSchema().properties.claude_model.description;
  // Opus 5's 200K against everything else's 1M is the one fact here that
  // changes a choice, and this plugin replays the whole conversation every
  // turn, so it bites sooner than it would elsewhere.
  assert.match(description, /200K/);
  assert.match(description, /1M context|1M/);
  assert.match(readSettings({ backend: "claude" }).models[1].note, /200K/);
});

// ── setting the CLIs up ─────────────────────────────────────────────────────

test("the plugin registers exactly the two tools it claims to", async () => {
  const h = await Harness.create(app).start();
  const names = (await h.listTools()).map((t) => t.name).sort();
  // This plugin is normally the model, so every tool it registers is one the
  // model then reads in its own catalogue. Two is a deliberate ceiling.
  assert.deepEqual(names, ["subscription_setup", "subscription_status"]);
});

test("a check names every CLI and how to get the missing ones", async (t) => {
  const h = await Harness.create(app)
    .withConfig({
      // Nothing real, so every one comes back missing — which is the state a
      // new user is in and the one the advice has to be right for.
      claude_command: "definitely-not-a-real-binary-9f3a",
      codex_command: "definitely-not-a-real-binary-9f3a",
      ledger_path: scratchLedger(t),
    })
    .start();

  const result = await h.callTool("subscription_setup", {});
  assert.equal(result.success, true);
  for (const label of ["Claude Code", "Codex CLI"]) {
    assert.ok(result.result.includes(label), `${label} missing from the report`);
  }
  // Both say the command. The plugin does not run it for you — see README.
  assert.match(result.result, /npm i -g @anthropic-ai\/claude-code/);
  // Signing in is the plugin's job to report and never to perform.
  assert.match(result.result, /never handles credentials/);
});

test("both backends are installed the same way, from npm", () => {
  assert.equal(INSTALL_PLANS.claude.packageName, "@anthropic-ai/claude-code");
  assert.equal(INSTALL_PLANS.codex.packageName, "@openai/codex");
  // Nothing Google is left: Gemini CLI stopped serving individual accounts and
  // its replacement refuses by region, so both were cut rather than shipped
  // as code nobody could run. See README.
  assert.deepEqual(Object.keys(INSTALL_PLANS).sort(), ["claude", "codex"]);
});

test("a v-prefixed version still counts as installed", async () => {
  // `node --version` answers `v24.19.0`, and a leading  does not match
  // between `v` and `2`. Requiring one reported every such CLI as missing.
  const status = await probe("codex", "test", process.execPath);
  assert.equal(status.problem, "");
  assert.match(status.version, /^\d+\.\d+\.\d+/);
});

// ── settings ────────────────────────────────────────────────────────────────

test("settings fall back rather than trusting what the daemon delivered", () => {
  assert.equal(readSettings({}).backend, "claude");
  assert.equal(readSettings({ backend: "nonsense" }).backend, "claude");
  assert.equal(readSettings({ backend: "codex" }).command, "codex");
  // An emptied box is not a command named "".
  assert.equal(readSettings({ claude_command: "   " }).command, "claude");
  // Numbers arriving as strings, as they have before now.
  assert.equal(readSettings({ turns_per_day: "12" }).turnsPerDay, 12);
  // Nonsense in a number field takes the default, it does not become NaN.
  assert.equal(readSettings({ turns_per_day: "soon" }).turnsPerDay, 400);
  assert.equal(readSettings({ turns_per_hour: -5 }).turnsPerHour, 60);
  assert.equal(readSettings({ turns_per_hour: 2.7 }).turnsPerHour, 2);
  // A timeout below the floor is raised to it, not honoured.
  assert.equal(readSettings({ turn_timeout_secs: 1 }).turnTimeoutSecs, 10);
  assert.deepEqual(readSettings({ extra_args: "  --a   --b " }).extraArgs, ["--a", "--b"]);
});

test("the model is picked per backend, not shared between them", () => {
  const config = { claude_model: "opus", codex_model: "gpt-5.6-terra" };
  assert.equal(readSettings({ ...config, backend: "claude" }).model, "opus");
  assert.equal(readSettings({ ...config, backend: "codex" }).model, "gpt-5.6-terra");
  // Switching backends must not hand Codex a name only Claude Code knows.
  assert.equal(readSettings({ claude_model: "opus", backend: "codex" }).model, "");
});

test("a model set before the lists existed is still honoured", () => {
  // 0.1.0 had one `model` box. An upgrade must not quietly reset the choice.
  assert.equal(readSettings({ model: "sonnet" }).model, "sonnet");
  // The new field wins when both are set.
  assert.equal(readSettings({ model: "sonnet", claude_model: "opus" }).model, "opus");
});

test("every offered Claude model is one the CLI actually accepts", () => {
  const { models } = readSettings({ backend: "claude" });
  // Checked against a live subscription on 2026-08-19: each of these answered.
  // Aliases, not full names, so they follow the model when it is updated.
  assert.deepEqual(models.map((m) => m.cli), ["", "claude-opus-5", "fable", "sonnet", "haiku", "opus"]);
  // Opus 5 is the one full name in the list, and it has to be: `opus` still
  // resolves to 4.8 and `opus-5` is not an alias at all. A list that offered
  // only the short name would quietly hand over the older model.
  assert.ok(models.some((m) => m.cli === "claude-opus-5"));
  assert.ok(!models.some((m) => m.cli === "opus-5"), "opus-5 is refused by the CLI");
  // The empty one must mean "say nothing", not `--model ""`.
  const { args } = claudeBackend.build({ system: "S", prompt: "P", model: "", effort: "", mcpConfigFile: null, extraArgs: [] });
  assert.ok(!args.includes("--model"));
});

test("each backend offers its own list, and nothing retired", () => {
  const codex = readSettings({ backend: "codex" }).models.map((m) => m.cli);
  assert.deepEqual(codex, ["", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.3-codex-spark"]);
  // Retired on 31 August 2026. An entry that stops resolving is worse than
  // one that was never offered.
  assert.ok(!codex.includes("gpt-5.4"));
  assert.ok(!codex.includes("gpt-5.4-mini"));

  // Gemini's list is read out of the CLI's own registry, not its docs — the
  // published page names four because it describes the /model picker's Auto
  // options, while --model takes every entry extending `chat-base-3`.

  // The variant tuned for custom tools, which is what every Astra tool reaches
  // this model as.
  // Local models: no quota at all, which is the opposite of what this plugin
  // otherwise rations.
  // The CLI's internal role configs are not models and must not leak in.
});

test("the override beats every dropdown, because every dropdown goes stale", () => {
  assert.equal(readSettings({ backend: "codex", codex_model: "gpt-5.5", model_override: "gpt-6" }).model, "gpt-6");
  assert.equal(readSettings({ backend: "claude", claude_model: "sonnet", model_override: "claude-opus-6" }).model, "claude-opus-6");
  // Empty means "not overriding", not "no model".
  assert.equal(readSettings({ backend: "claude", claude_model: "sonnet", model_override: "  " }).model, "sonnet");
});

test("Astra's own Model box is the last resort, and never an API-style id", async (t) => {
  // The daemon has no way to fill its picker from a plugin — it never asks —
  // so that box is free text. Honour it, but only when nothing here is set.
  const h = await Harness.create(app)
    .withConfig({ claude_command: "definitely-not-a-real-binary-9f3a", ledger_path: scratchLedger(t) })
    .start();

  // A slash means it is an API model id, which no agent CLI accepts. Passing
  // it through would fail every turn over a name nobody deliberately chose.
  for (const model of ["openai/gpt-4o-mini", ""]) {
    const { chunks } = await h.aiComplete({ model, messages: [{ role: "user", content: "hi" }], tools: [] });
    assert.match(chunks.find((c) => c.error)?.error ?? "", /not installed|not on PATH/);
  }
});

// ── gemini, which configures itself from a directory ────────────────────────

test("effort words Astra knows but the CLIs do not are dropped, not guessed", () => {
  assert.equal(normaliseEffort("high"), "high");
  assert.equal(normaliseEffort("max"), "max");
  // "off" has no rung on either CLI's scale; mapping it to `low` would be
  // inventing a decision the user did not make.
  assert.equal(normaliseEffort("off"), "");
  assert.equal(normaliseEffort("auto"), "");
  assert.equal(normaliseEffort(""), "");
});

// ── the ledger ──────────────────────────────────────────────────────────────

const settingsFor = (over = {}) => readSettings({ turns_per_hour: 0, turns_per_day: 0, tokens_per_day: 0, ...over });

test("windows roll, so nothing is counted twice and nothing lingers", () => {
  const now = 1_000 * budget.HOUR_MS;
  const ledger = {
    turns: [
      { at: now - 30 * 60_000, tokens: 100 },      // this hour
      { at: now - 5 * budget.HOUR_MS, tokens: 200 }, // today, not this hour
      { at: now - 30 * budget.HOUR_MS, tokens: 999 }, // gone
    ],
  };
  const used = budget.measure(ledger, now);
  assert.equal(used.turnsHour, 1);
  assert.equal(used.turnsDay, 2);
  assert.equal(used.tokensDay, 300, "the turn older than a day must not be counted");
  assert.equal(budget.prune(ledger, now).turns.length, 2);
});

test("a limit of 0 is off, not a limit of zero turns", () => {
  const ledger = budget.record(budget.emptyLedger(), Date.now(), 500);
  assert.equal(budget.check(settingsFor(), ledger, Date.now()).allowed, true);
});

test("a spent limit refuses, and says when it frees up", () => {
  const now = 5_000_000_000;
  let ledger = budget.emptyLedger();
  for (let i = 0; i < 3; i++) ledger = budget.record(ledger, now - 10 * 60_000, 10);

  const verdict = budget.check(settingsFor({ turns_per_hour: 3 }), ledger, now);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /Hourly turn limit reached \(3\)/);
  assert.match(verdict.reason, /50 min/, "the oldest turn ages out 50 minutes from now");
  // Astra can hold the retry rather than asking the user to guess.
  assert.ok(verdict.retryAfterMs > 0 && verdict.retryAfterMs <= budget.HOUR_MS);
});

test("warn mode lets the turn through and still says so", () => {
  const now = 5_000_000_000;
  let ledger = budget.emptyLedger();
  for (let i = 0; i < 3; i++) ledger = budget.record(ledger, now, 10);

  const verdict = budget.check(settingsFor({ turns_per_hour: 3, on_limit: "warn" }), ledger, now);
  assert.equal(verdict.allowed, true);
  assert.match(verdict.warning, /Hourly turn limit reached/);
});

test("the token limit is separate from the turn limit", () => {
  const now = 5_000_000_000;
  const ledger = budget.record(budget.emptyLedger(), now - 60_000, 50_000);
  assert.equal(budget.check(settingsFor({ tokens_per_day: 40_000 }), ledger, now).allowed, false);
  assert.equal(budget.check(settingsFor({ tokens_per_day: 60_000 }), ledger, now).allowed, true);
});

test("a warning arrives before the limit does, not with it", () => {
  const now = 5_000_000_000;
  let ledger = budget.emptyLedger();
  for (let i = 0; i < 8; i++) ledger = budget.record(ledger, now, 1);

  const verdict = budget.check(settingsFor({ turns_per_hour: 10 }), ledger, now);
  assert.equal(verdict.allowed, true);
  assert.match(verdict.warning, /turns this hour: 8\/10/);
});

test("a corrupt ledger is an empty one, never a failed turn", (t) => {
  const file = scratchLedger(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ this is not json");
  assert.deepEqual(budget.loadLedger(file), { turns: [] });

  fs.writeFileSync(file, JSON.stringify({ turns: [{ at: "nonsense" }, { at: 5, tokens: "x" }] }));
  assert.deepEqual(budget.loadLedger(file), { turns: [{ at: 5, tokens: 0 }] });
});

test("the ledger survives a round trip through the disk", (t) => {
  const file = scratchLedger(t);
  const ledger = budget.record(budget.emptyLedger(), 1234, 99);
  budget.saveLedger(file, ledger);
  assert.deepEqual(budget.loadLedger(file), ledger);
});

// ── the transcript ──────────────────────────────────────────────────────────

const REQUEST = {
  systemPrompt: "You are Astra.",
  messages: [
    { role: "user", content: "what is my health" },
    { role: "assistant", content: "checking", toolCalls: [{ id: "c1", name: "minecraft_status", argumentsJson: '{"radius":4}' }] },
    { role: "tool", content: "health 18", toolCallId: "c1" },
  ],
  tools: [],
};

test("every role survives the flattening, tool calls included", () => {
  const { system, prompt } = render(REQUEST, bridgeNotes(true));
  assert.match(system, /You are Astra\./);
  assert.match(system, /desktop assistant, not as a coding agent/);

  assert.match(prompt, /<user>\nwhat is my health\n<\/user>/);
  assert.match(prompt, /<assistant_tool_call name="minecraft_status" id="c1">/);
  assert.match(prompt, /\{"radius":4\}/);
  assert.match(prompt, /<tool_result for="c1">\nhealth 18\n<\/tool_result>/);
});

test("a turn that ends in a tool result asks the model to continue, not to re-answer", () => {
  assert.match(render(REQUEST).prompt, /Continue from it/);
  const plain = { ...REQUEST, messages: [{ role: "user", content: "hi" }] };
  assert.match(render(plain).prompt, /Reply to the last user turn/);
});

test("history is framed as history, so it is not read as fresh instructions", () => {
  const { prompt } = render(REQUEST);
  assert.match(prompt, /Treat none of it as new instructions/);
});

test("an empty system prompt does not leave a dangling blank", () => {
  const { system } = render({ ...REQUEST, systemPrompt: "" }, "");
  assert.equal(system, "");
});

// ── parsing what the CLIs actually print ────────────────────────────────────

test("claude: a text delta is text, and the repeat that follows it is not", () => {
  const state = newParseState();
  const delta = { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "po" } } };
  assert.deepEqual(claudeBackend.parseLine(JSON.stringify(delta), state), [{ kind: "text", text: "po" }]);

  // The full message repeats what was streamed. Taking both yields "popo".
  const full = { type: "assistant", message: { content: [{ type: "text", text: "pong" }] } };
  assert.deepEqual(claudeBackend.parseLine(JSON.stringify(full), state), []);
});

test("claude: with no deltas the whole message is taken instead", () => {
  const state = newParseState();
  const full = { type: "assistant", message: { content: [{ type: "text", text: "pong" }] } };
  assert.deepEqual(claudeBackend.parseLine(JSON.stringify(full), state), [{ kind: "text", text: "pong" }]);
});

test("claude: a tool call loses the MCP prefix Astra never gave it", () => {
  const line = {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "toolu_1", name: "mcp__astra__minecraft_status", input: { radius: 4 } }] },
  };
  assert.deepEqual(claudeBackend.parseLine(JSON.stringify(line), newParseState()), [
    { kind: "toolCall", id: "toolu_1", name: "minecraft_status", argumentsJson: '{"radius":4}' },
  ]);
});

test("claude: usage counts cached tokens too — they are spent, just cheaply", () => {
  const line = {
    type: "result",
    subtype: "success",
    usage: { input_tokens: 2, cache_creation_input_tokens: 19132, cache_read_input_tokens: 100, output_tokens: 4 },
    total_cost_usd: 0.0239722,
  };
  assert.deepEqual(claudeBackend.parseLine(JSON.stringify(line), newParseState()), [
    { kind: "usage", tokens: 19238, costUsd: 0.0239722 },
  ]);
});

test("claude: the provider's own throttle is reported, but not when it is fine", () => {
  const allowed = { type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour" } };
  assert.deepEqual(claudeBackend.parseLine(JSON.stringify(allowed), newParseState()), []);

  const warned = { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", resetsAt: 1787174400 } };
  const [event] = claudeBackend.parseLine(JSON.stringify(warned), newParseState());
  assert.equal(event.kind, "rateLimit");
  assert.match(event.detail, /five_hour: allowed_warning/);
});

test("neither parser throws on a line it cannot read", () => {
  for (const backend of [claudeBackend, codexBackend]) {
    assert.deepEqual(backend.parseLine("not json at all", newParseState()), []);
    assert.deepEqual(backend.parseLine("null", newParseState()), []);
    assert.deepEqual(backend.parseLine('{"type":"something_new"}', newParseState()), []);
  }
});

test("codex: an MCP call is caught when it starts, before it can run", () => {
  const line = {
    type: "item.started",
    item: { id: "item_2", type: "mcp_tool_call", server: "astra", tool: "minecraft_status", arguments: { radius: 4 } },
  };
  assert.deepEqual(codexBackend.parseLine(JSON.stringify(line), newParseState()), [
    { kind: "toolCall", id: "item_2", name: "minecraft_status", argumentsJson: '{"radius":4}' },
  ]);
});

test("codex: the answer and the token count come from their own events", () => {
  const message = { type: "item.completed", item: { id: "item_3", type: "agent_message", text: "Done." } };
  assert.deepEqual(codexBackend.parseLine(JSON.stringify(message), newParseState()), [{ kind: "text", text: "Done." }]);

  const turn = { type: "turn.completed", usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122 } };
  assert.deepEqual(codexBackend.parseLine(JSON.stringify(turn), newParseState()), [
    { kind: "usage", tokens: 49333, costUsd: 0 },
  ]);
});

// ── the flags, which are the expensive part to get wrong ────────────────────

test("claude is invoked with the flags that make it a model instead of an agent", () => {
  const { args } = claudeBackend.build({ system: "S", prompt: "P", model: "opus", effort: "high", mcpConfigFile: "C:/tmp/mcp.json", extraArgs: [] });
  const flag = (name) => args[args.indexOf(name) + 1];

  // stream-json is refused without --verbose; the CLI says so.
  assert.ok(args.includes("--verbose"));
  assert.equal(flag("--output-format"), "stream-json");
  assert.equal(flag("--system-prompt"), "S");
  assert.equal(flag("--model"), "opus");
  assert.equal(flag("--effort"), "high");
  assert.equal(flag("--mcp-config"), "C:/tmp/mcp.json");

  // The measured difference between doing this and not: 33 665 prompt tokens
  // against 502. Built-in tools are most of Claude Code's prompt.
  const disallowed = flag("--disallowed-tools").split(",");
  for (const name of ["Bash", "Read", "Write", "Edit", "WebSearch", "Task", "TodoWrite"]) {
    assert.ok(disallowed.includes(name), `${name} must be disallowed or its schema is back in the prompt`);
  }
  // --safe-mode would take our own MCP server with it. --strict-mcp-config
  // ignores every OTHER config, which is the thing we actually wanted.
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(!args.includes("--safe-mode"));
  // --allowed-tools is a permission allowlist, not a catalogue filter: naming
  // one tool there leaves every other definition in the prompt.
  assert.ok(!args.includes("--allowed-tools"));
});

test("with no tools to pass, no MCP server is wired up at all", () => {
  const { args } = claudeBackend.build({ system: "S", prompt: "P", model: "", effort: "", mcpConfigFile: null, extraArgs: [] });
  assert.ok(!args.includes("--mcp-config"));
  assert.ok(!args.includes("--permission-mode"), "nothing to permit when nothing is offered");
  assert.ok(!args.includes("--model"), "an empty model box must not become --model ''");
});

test("codex puts the persona in the prompt, because it has no flag for one", () => {
  const { args, stdin } = codexBackend.build({ system: "S", prompt: "P", model: "", effort: "", mcpConfigFile: null, extraArgs: [] });
  assert.ok(args.includes("exec") && args.includes("--json"));
  assert.match(stdin, /<instructions>\nS\n<\/instructions>/);
  assert.match(stdin, /P/);
});

// ── the runner, against a CLI that costs nothing ────────────────────────────

async function collect(mode, timeoutMs = 10_000, stopOnToolCall = true) {
  const events = [];
  for await (const event of run(process.execPath, { args: [FAKE_CLI, mode], stdin: "prompt" }, claudeBackend, timeoutMs)) {
    events.push(event);
    if (stopOnToolCall && event.kind === "toolCall") break;
  }
  return events;
}

test("a whole turn arrives in order: text first, cost last", async () => {
  const events = await collect("text");
  assert.deepEqual(
    events.filter((e) => e.kind === "text").map((e) => e.text),
    ["p", "ong"],
    "the streamed deltas, and not the full message repeating them",
  );
  const usage = events.at(-1);
  assert.equal(usage.kind, "usage");
  assert.equal(usage.tokens, 19138);
  assert.ok(events.some((e) => e.kind === "rateLimit"));
});

test("breaking on a tool call kills the CLI that is waiting for the shim", async () => {
  const started = Date.now();
  const events = await collect("tool", 30_000);
  const call = events.find((e) => e.kind === "toolCall");
  assert.equal(call.name, "minecraft_status");
  assert.equal(call.argumentsJson, '{"radius":4}');
  // The fake CLI would sit there for a minute. If the generator's `finally`
  // did not kill it, this test would too.
  assert.ok(Date.now() - started < 15_000, "the process must not be waited on after the call");
});

test("a CLI that never speaks is given up on, with the timeout in the message", async () => {
  await assert.rejects(collect("hang", 1_200), /did not finish within 1 s/);
});

test("a CLI that fails says what it printed, not just its exit code", async () => {
  await assert.rejects(collect("crash"), (err) => {
    assert.match(err.message, /exited with code 1/);
    assert.match(err.message, /Please run \/login/, "stderr is where the actionable half is");
    return true;
  });
});

test("a binary that is not there is named as missing, not as a spawn failure", async () => {
  await assert.rejects(
    (async () => {
      for await (const _ of run("definitely-not-a-real-binary-9f3a", { args: [], stdin: "" }, claudeBackend, 5_000)) {
        /* nothing arrives */
      }
    })(),
    CliMissing,
  );
});

// ── launching an npm-installed CLI on Windows ───────────────────────────────

const windowsOnly = { skip: process.platform !== "win32" ? "Windows only" : false };

test("an npm .cmd shim is run as the script it wraps, not through a shell", windowsOnly, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astra-shim-cmd-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // npm's real shim, shortened. The path is what has to come out.
  fs.mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
  const script = path.join(dir, "node_modules", "pkg", "cli.js");
  fs.writeFileSync(script, "// the actual program");
  fs.writeFileSync(
    path.join(dir, "faketool.cmd"),
    String.raw`@ECHO off
SET dp0=%~dp0
"%_prog%"  "%dp0%\node_modules\pkg\cli.js" %*
`,
  );

  const launcher = resolveLauncher(path.join(dir, "faketool.cmd"));
  // Node refuses to spawn a .cmd at all since 18.20 (CVE-2024-27980), and a
  // shell is not the answer: these arguments carry a system prompt.
  assert.equal(launcher.command, process.execPath);
  assert.deepEqual(launcher.prefix, [script]);
});

test("a shim naming a script that is not there is left alone", windowsOnly, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astra-shim-cmd-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shim = path.join(dir, "faketool.cmd");
  fs.writeFileSync(shim, String.raw`"%_prog%"  "%dp0%\node_modules\gone\cli.js" %*`);

  // Better to attempt the spawn and let the runner explain than to invent a
  // path that does not exist.
  assert.equal(resolveLauncher(shim).command, shim);
  assert.deepEqual(resolveLauncher(shim).prefix, []);
});

test("an npm install's shell shim is skipped in favour of the .cmd", windowsOnly, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astra-shim-cmd-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // npm writes three files per binary. The extensionless one is a shell script
  // for Git Bash; Windows cannot run it, so preferring it resolves a working
  // install to a spawn that fails with ENOENT.
  fs.mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
  const script = path.join(dir, "node_modules", "pkg", "cli.js");
  fs.writeFileSync(script, "// the actual program");
  fs.writeFileSync(path.join(dir, "faketool"), "#!/bin/sh");
  fs.writeFileSync(
    path.join(dir, "faketool.cmd"),
    String.raw`"%_prog%"  "%dp0%\node_modules\pkg\cli.js" %*`,
  );

  const previous = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${previous}`;
  t.after(() => {
    process.env.PATH = previous;
  });

  const launcher = resolveLauncher("faketool");
  assert.equal(launcher.command, process.execPath, "the .cmd wins over the shell shim");
  assert.deepEqual(launcher.prefix, [script]);
});

test("a CLI installed after Astra started is still found", windowsOnly, (t) => {
  // A process inherits the environment it was started with. Astra's daemon may
  // predate the install, which is exactly how "works in my terminal, not in
  // Astra" happens — so PATH is not the only place worth looking.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "astra-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const npmDir = path.join(home, "Roaming", "npm");
  fs.mkdirSync(npmDir, { recursive: true });
  fs.writeFileSync(path.join(npmDir, "faketool.cmd"), "@ECHO off");

  const previousPath = process.env.PATH;
  const previousAppData = process.env.APPDATA;
  // A PATH that knows nothing about it, as a stale daemon's would be.
  process.env.PATH = path.join(home, "nowhere");
  process.env.APPDATA = path.join(home, "Roaming");
  t.after(() => {
    process.env.PATH = previousPath;
    process.env.APPDATA = previousAppData;
  });

  assert.equal(resolveLauncher("faketool").command, path.join(npmDir, "faketool.cmd"));
});

test("a real executable is passed through untouched", () => {
  const launcher = resolveLauncher(process.execPath);
  assert.equal(launcher.command, process.execPath);
  assert.deepEqual(launcher.prefix, []);
});

test("a command that is nowhere is handed to spawn anyway", () => {
  // The OS may still resolve it, and the runner already says something useful
  // when it cannot.
  assert.deepEqual(resolveLauncher("definitely-not-a-real-binary-9f3a"), {
    command: "definitely-not-a-real-binary-9f3a",
    prefix: [],
  });
});

// ── saying why a turn failed ────────────────────────────────────────────────

test("a stack trace is not an error message", () => {
  // What a user actually saw: the whole thing, frames and bundle paths and
  // all, presented as INTERNAL.
  const real =
    "Gemini CLI exited with code 1. An unexpected critical error occurred:IneligibleTierError: This client is " +
    "no longer supported for Gemini Code Assist for individuals. |     at throwIneligibleOrProjectIdError " +
    "(file:///C:/Users/x/AppData/Roaming/npm/node_modules/@google/gemini-cli/bundle/chunk-LZUWGCRJ.js:310030:11) " +
    "|     at _doSetupUser (file:///C:/…)";
  const short = readable(real);
  assert.ok(!short.includes("chunk-LZUWGCRJ"), "a path inside somebody else's bundle is not information");
  assert.ok(!short.includes("at throwIneligible"), "frames go");
  assert.ok(short.includes("IneligibleTierError"), "the cause stays");
});

test("the other known failures are each named for what they are", () => {
  assert.match(diagnose("Claude Code", "Invalid API key · Please run /login").message, /API key/);
  // A stale session is not a missing one, and the cheap status check cannot
  // tell them apart: `codex login status` reported "Logged in using ChatGPT"
  // for a token that could no longer be refreshed. Only a real turn found out.
  const stale = diagnose("Codex CLI", "Your access token could not be refreshed. Please log out and sign in again.");
  assert.match(stale.message, /session has gone stale/);
  assert.match(stale.message, /keep saying you are logged in/);
  assert.match(diagnose("Codex CLI", "authentication required").message, /nobody is signed in/);
  // The plan's own throttle, which no setting in this plugin can lift.
  assert.match(diagnose("Claude Code", "usage limit reached").message, /provider's throttle/);
  // Anything unrecognised stays as it was, rather than being mislabelled.
  assert.equal(diagnose("Claude Code", "ECONNRESET while reading the response"), null);
});

// ── the shim ────────────────────────────────────────────────────────────────

function shimExchange(toolsFile, lines) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SHIM, toolsFile], { stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => (out += c));
    child.on("close", () => resolve(out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))));
    for (const line of lines) child.stdin.write(`${JSON.stringify(line)}\n`);
    // Give a reply time to arrive before deciding there is not going to be one.
    setTimeout(() => child.stdin.end(), 400);
  });
}

test("the shim declares the tools it is given and answers the handshake", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astra-shim-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "tools.json");
  fs.writeFileSync(file, JSON.stringify([{ name: "minecraft_status", description: "Look around.", inputSchema: { type: "object" } }]));

  const replies = await shimExchange(file, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]);

  assert.equal(replies.length, 2, "a notification takes no reply");
  assert.equal(replies[0].result.protocolVersion, "2025-06-18");
  assert.deepEqual(replies[0].result.capabilities, { tools: {} });
  assert.equal(replies[1].result.tools[0].name, "minecraft_status");
});

test("the shim never answers a tool call, which is the whole trick", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astra-shim-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "tools.json");
  fs.writeFileSync(file, JSON.stringify([{ name: "t", description: "d", inputSchema: {} }]));

  const replies = await shimExchange(file, [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "t", arguments: {} } },
  ]);
  // Not an error either: an error is something the model reads and reacts to,
  // and every reaction is tokens spent on a turn that has already ended.
  assert.deepEqual(replies, []);
});

test("a missing tools file leaves the shim serving nothing rather than crashing", async () => {
  const replies = await shimExchange(path.join(os.tmpdir(), "no-such-file-9f3a.json"), [
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
  ]);
  assert.deepEqual(replies[0].result.tools, []);
});
