/**
 * A CLI that costs nothing.
 *
 * Everything the runner and the parsers do can be exercised without a
 * subscription, and should be: a test suite that needs one is a test suite
 * nobody runs. The lines below are copied from a real `claude -p --verbose
 * --output-format stream-json` capture rather than written from the docs, so
 * a field that the CLI renames breaks a test here instead of in production.
 *
 *   node fake-cli.mjs text        one text turn, streamed as deltas
 *   node fake-cli.mjs tool        a tool call, then silence (as the shim causes)
 *   node fake-cli.mjs error       a failed result
 *   node fake-cli.mjs hang        no output, ever — for the timeout path
 *   node fake-cli.mjs crash       exits non-zero with something on stderr
 */

const mode = process.argv[2] ?? "text";

const say = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

const RESULT_USAGE = {
  input_tokens: 2,
  cache_creation_input_tokens: 19132,
  cache_read_input_tokens: 0,
  output_tokens: 4,
};

// Read and discard stdin: the real CLI reads until EOF, and a runner that
// forgets to close the pipe should hang here too rather than pass by luck.
process.stdin.resume();
process.stdin.on("data", () => {});

if (mode === "hang") {
  setTimeout(() => {}, 60_000);
} else if (mode === "crash") {
  process.stderr.write("Invalid API key · Please run /login\n");
  process.exit(1);
} else if (mode === "error") {
  say({ type: "result", subtype: "error_during_execution", is_error: true, result: "model overloaded", usage: RESULT_USAGE, total_cost_usd: 0.001 });
  process.exit(0);
} else if (mode === "tool") {
  say({ type: "system", subtype: "init", tools: ["mcp__astra__minecraft_status"], mcp_servers: [{ name: "astra", status: "connected" }] });
  say({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "checking" } } });
  say({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "toolu_01EjQ12QdH19X5HVgwhDHPpA", name: "mcp__astra__minecraft_status", input: { radius: 4 } },
      ],
    },
  });
  // The real CLI now blocks on the shim and never reaches `result`. So do we.
  setTimeout(() => {}, 60_000);
} else {
  say({ type: "system", subtype: "init", tools: [], mcp_servers: [] });
  say({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
  say({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "p" } } });
  say({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: 1787174400, rateLimitType: "five_hour" } });
  say({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ong" } } });
  // The full assistant message repeats what the deltas already said. A parser
  // that takes both yields "pongpong", which is the bug this line is here for.
  say({ type: "assistant", message: { content: [{ type: "text", text: "pong" }] } });
  say({ type: "result", subtype: "success", is_error: false, result: "pong", usage: RESULT_USAGE, total_cost_usd: 0.0239722 });
  process.exit(0);
}
