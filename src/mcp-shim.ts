/**
 * A deliberately inert MCP server.
 *
 * The problem it solves: Astra wants a `toolCall` chunk back so *it* can run
 * the tool. An agent CLI wants to run the tool itself and hand back only the
 * finished answer. Somewhere between those two the call has to be intercepted.
 *
 * The interception point is the output stream, not this process. Claude Code
 * emits the `tool_use` block before the tool runs, so the bridge sees the call,
 * reports it to Astra and kills the CLI — which means the handler here is never
 * required to return anything. That is why this server declares the tools
 * faithfully and then does nothing at all when one is called: answering would
 * be answering a question nobody is still waiting for.
 *
 * It stalls rather than erroring because an error is something the model reads
 * and reacts to — retrying, apologising, picking a different tool — and every
 * one of those reactions is tokens spent on a turn that has already ended.
 *
 * Spawned as `node dist/mcp-shim.js <tools.json>`, one per turn, over stdio.
 */

import fs from "node:fs";

interface McpTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

interface Rpc {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_FALLBACK = "2025-06-18";

function loadTools(file: string): McpTool[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? (parsed as McpTool[]) : [];
  } catch {
    return [];
  }
}

const tools = loadTools(process.argv[2] ?? "");

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function handle(msg: Rpc): void {
  // A notification has no id and takes no reply — `notifications/initialized`
  // above all, which is the one every client sends.
  if (msg.id === undefined) return;

  switch (msg.method) {
    case "initialize":
      send({
        id: msg.id,
        result: {
          // Echo the client's version when it names one: this server implements
          // the intersection of every version that has `tools/list`, so the
          // client's choice is always one it can speak.
          protocolVersion:
            typeof msg.params?.protocolVersion === "string"
              ? msg.params.protocolVersion
              : PROTOCOL_FALLBACK,
          capabilities: { tools: {} },
          serverInfo: { name: "astra-tools", version: "1.0.0" },
        },
      });
      return;

    case "tools/list":
      send({ id: msg.id, result: { tools } });
      return;

    case "ping":
      send({ id: msg.id, result: {} });
      return;

    case "tools/call":
      // Intentionally no reply. See the header.
      return;

    default:
      send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      try {
        handle(JSON.parse(line) as Rpc);
      } catch {
        /* a line we cannot parse is a line we cannot answer */
      }
    }
    newline = buffer.indexOf("\n");
  }
});

// The CLI closing its end is the CLI going away; there is nothing left to serve.
process.stdin.on("end", () => process.exit(0));
