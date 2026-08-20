/**
 * The checks that need a subscription.
 *
 * Everything in `plugin.test.mjs` runs against a fake CLI, which proves the
 * plugin reads what a CLI prints — not that the CLI still prints it, and not
 * that it accepts these flags. That is what this file is for, and why it is
 * not in `npm test`: it spends real quota, a few hundred tokens a run.
 *
 *   node test/live-cli.mjs [claude|codex|gemini] [model]
 *
 * Needs `npm run pretest` first, and that backend's CLI installed and signed
 * in. The three differ in how they take their configuration and not in what
 * they have to end up doing, which is the point of running the same four
 * checks against each.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { app } = require("../.test-build/plugin.cjs");
const { Harness } = require("astra-plugin-sdk/testing");

const backend = process.argv[2] ?? "claude";
const model = process.argv[3] ?? "";
const ledger = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "astra-live-")), "usage.json");
let failures = 0;

console.log(`backend: ${backend}${model ? ` · model: ${model}` : ""}`);

function report(label, passed, detail = "") {
  console.log(`${passed ? "ok  " : "FAIL"}  ${label}${detail ? `\n      ${detail}` : ""}`);
  if (!passed) failures++;
}

const h = await Harness.create(app)
  .withConfig({
    backend,
    model_override: model,
    // No limits: this file is testing the bridge, not the ledger.
    turns_per_hour: 0,
    turns_per_day: 0,
    tokens_per_day: 0,
    turn_timeout_secs: 180,
    ledger_path: ledger,
  })
  .start();

// The harness hands back chunks in their wire shape, where a text delta is
// `textDelta` rather than the `text` the SDK takes. Read both: the daemon has
// renamed a field before, and a test that only knows one name goes quiet
// rather than failing when it happens.
const text = (chunks) => chunks.map((c) => c.textDelta ?? c.text ?? "").join("");
const toolCallOf = (chunks) => chunks.map((c) => c.toolCall ?? c.tool_call).find(Boolean);

// 1. Plain prose, no tools. The flags have to be accepted and the stream read.
{
  const started = Date.now();
  const { chunks } = await h.aiComplete({
    systemPrompt: "You are terse. Answer in one word.",
    messages: [{ role: "user", content: "Reply with the single word: pong" }],
    tools: [],
  });
  const answer = text(chunks).trim();
  const err = chunks.find((c) => c.error)?.error;
  report(`a turn with no tools answers (${((Date.now() - started) / 1000).toFixed(1)}s)`, /pong/i.test(answer), err ?? JSON.stringify(answer));
  report("the stream is terminated exactly once", chunks.filter((c) => c.done).length === 1);
}

// 2. The interesting half: a tool Astra owns, offered over the shim, and the
//    call coming back for Astra to run rather than being run by the CLI.
{
  const started = Date.now();
  const { chunks } = await h.aiComplete({
    systemPrompt: "You are a desktop assistant. When a tool can answer, call it rather than guessing.",
    messages: [{ role: "user", content: "What is the weather in Moscow right now?" }],
    tools: [
      {
        name: "get_weather",
        description: "Get the current weather for a city. Use this for any weather question.",
        parametersJson: JSON.stringify({
          type: "object",
          properties: { city: { type: "string", description: "City name" } },
          required: ["city"],
        }),
      },
    ],
  });

  const call = toolCallOf(chunks);
  const err = chunks.find((c) => c.error)?.error;
  report(`a tool call comes back instead of prose (${((Date.now() - started) / 1000).toFixed(1)}s)`, !!call, err ?? text(chunks).slice(0, 200));
  if (call) {
    report("named as Astra named it, with no MCP prefix", call.name === "get_weather", call.name);
    report("with the arguments the model chose", /Moscow/i.test(call.argumentsJson), call.argumentsJson);
  }
}

// 3. The turn after a tool call: the result goes back in, prose comes out.
{
  const { chunks } = await h.aiComplete({
    systemPrompt: "You are a desktop assistant.",
    messages: [
      { role: "user", content: "What is the weather in Moscow right now?" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "get_weather", argumentsJson: '{"city":"Moscow"}' }] },
      { role: "tool", content: "-7C, light snow", toolCallId: "c1" },
    ],
    tools: [],
  });
  const answer = text(chunks);
  report("the tool result is read back and answered from", /-?7|snow|снег/i.test(answer), answer.slice(0, 200));
}

// 4. The ledger moved. Three turns ran; three turns are on the books.
{
  const status = await h.callTool("subscription_status", {});
  const turns = Number(/Turns today: (\d+)/.exec(status.result)?.[1] ?? -1);
  report("every turn reached the ledger", turns === 3, status.result);
}

await h.shutdown();
fs.rmSync(path.dirname(ledger), { recursive: true, force: true });

console.log(failures === 0 ? "\nAll live checks passed." : `\n${failures} live check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
