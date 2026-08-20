/**
 * Codex CLI, driven the same way.
 *
 * Half-verified, and said plainly rather than buried. This backend has answered
 * through Astra on a live ChatGPT subscription (Codex CLI 0.148.0, 2026-08-20),
 * so the shape below is not theoretical. What has not gone green is
 * `test/live-cli.mjs codex`: the session on this machine expired before those
 * four checks could run — HTTP 401 while `codex login status` still said
 * "Logged in using ChatGPT", which is exactly the case `diagnose.ts` names.
 *
 * So unlike the Claude backend next door, the flags and event shapes here still
 * come from OpenAI's non-interactive docs and the community event cheatsheet
 * rather than from a passing suite. The event names are the part most likely to
 * drift; they are all in `parseLine` and nowhere else, so fixing a rename is a
 * one-function job.
 *
 * Two differences from Claude Code that are structural rather than incidental:
 *
 * - `codex exec --json` has no partial-message events. `agent_message` arrives
 *   completed, so the reply lands in one chunk instead of streaming. Astra
 *   renders it the same; it just appears all at once.
 * - MCP servers are configured through `-c` overrides rather than a config
 *   file, so the same shim is pointed at with three key/value pairs.
 */

import type { Backend, BackendEvent, LaunchSpec, ParseState } from "./types.js";
import { MCP_SERVER } from "./types.js";

interface CodexLine {
  type?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    server?: string;
    tool?: string;
    arguments?: unknown;
  };
  usage?: Record<string, number>;
  error?: { message?: string };
  message?: string;
}

export const codexBackend: Backend = {
  id: "codex",
  label: "Codex CLI",
  versionArgs: ["--version"],

  // Codex takes MCP servers as config overrides, not as a file. The file this
  // returns is written anyway and its path passed through `-c`, so the two
  // backends can share one call site.
  mcpConfig(shimPath, toolsFile) {
    return { command: process.execPath, args: [shimPath, toolsFile] };
  },

  build({ system, prompt, model, effort, mcpConfigFile, extraArgs }): LaunchSpec {
    const args = ["exec", "--json", "--skip-git-repo-check"];
    if (model) args.push("-m", model);
    if (effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);

    // Codex has no `--system-prompt`. The persona goes at the head of the
    // prompt instead, fenced so it reads as instruction rather than as the
    // conversation it precedes.
    const stdin = system ? `<instructions>\n${system}\n</instructions>\n\n${prompt}` : prompt;

    if (mcpConfigFile) {
      const shim = JSON.parse(mcpConfigFile) as { command: string; args: string[] };
      args.push(
        "-c", `mcp_servers.${MCP_SERVER}.command=${JSON.stringify(shim.command)}`,
        "-c", `mcp_servers.${MCP_SERVER}.args=${JSON.stringify(shim.args)}`,
        // Astra decides what may run; a second approval prompt here has no one
        // to answer it. The shim executes nothing regardless.
        "--dangerously-bypass-approvals-and-sandbox",
      );
    }
    args.push(...extraArgs, "-");
    return { args, stdin };
  },

  parseLine(line, _state): BackendEvent[] {
    let data: CodexLine;
    try {
      const parsed: unknown = JSON.parse(line);
      // `JSON.parse("null")` returns null rather than throwing, and a bare
      // `null` on stdout is a line a CLI can legally print.
      if (!parsed || typeof parsed !== "object") return [];
      data = parsed as CodexLine;
    } catch {
      return [];
    }
    const out: BackendEvent[] = [];

    switch (data.type) {
      // `item.started`, not `item.completed`: a completed MCP call is one that
      // already ran, and the whole point is to catch it before it does. The
      // shim stalls, so started is the last event we will see for it anyway.
      case "item.started":
        if (data.item?.type === "mcp_tool_call" && data.item.server === MCP_SERVER) {
          out.push({
            kind: "toolCall",
            id: data.item.id ?? "",
            name: data.item.tool ?? "",
            argumentsJson: JSON.stringify(data.item.arguments ?? {}),
          });
        }
        break;

      case "item.completed":
        if (data.item?.type === "agent_message" && data.item.text) {
          out.push({ kind: "text", text: data.item.text });
        } else if (data.item?.type === "reasoning" && data.item.text) {
          out.push({ kind: "thinking", text: data.item.text });
        } else if (data.item?.type === "mcp_tool_call" && data.item.server === MCP_SERVER) {
          out.push({
            kind: "toolCall",
            id: data.item.id ?? "",
            name: data.item.tool ?? "",
            argumentsJson: JSON.stringify(data.item.arguments ?? {}),
          });
        }
        break;

      case "turn.completed": {
        const usage = data.usage ?? {};
        out.push({
          kind: "usage",
          tokens:
            (usage.input_tokens ?? 0) + (usage.cached_input_tokens ?? 0) + (usage.output_tokens ?? 0),
          // Codex reports no price. The ledger's cost column stays at zero and
          // a cost limit is simply never reached — which is why the settings
          // say the money limit is Claude-only rather than pretending.
          costUsd: 0,
        });
        break;
      }

      case "turn.failed":
      case "error":
        out.push({ kind: "error", message: data.error?.message ?? data.message ?? "Codex failed" });
        break;
    }
    return out;
  },
};
