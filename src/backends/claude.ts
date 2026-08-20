/**
 * Claude Code, driven as a completion endpoint.
 *
 * Every flag below was measured on a real CLI (2.1.211) rather than read off a
 * page, because the difference between the obvious invocation and the right one
 * is two orders of magnitude:
 *
 *   plain `-p` with a replaced system prompt      33 665 prompt tokens
 *   ...plus every built-in tool disallowed             502 prompt tokens
 *
 * Claude Code is an agent, and an agent's prompt is mostly its tools. Turning
 * them off is what turns it back into a model. The tools the model *should*
 * see are Astra's, and they arrive over `--mcp-config`.
 *
 * Two traps, both found the same way:
 *
 * - `--safe-mode` looks like the isolation flag and is not: it disables MCP
 *   servers too, ours included, and the model is handed nothing. Use
 *   `--strict-mcp-config`, which ignores every MCP config except the one given.
 * - `--allowed-tools` is a permission allowlist, not a catalogue filter. Naming
 *   one tool there leaves all the others in the prompt — it measured 33 665
 *   tokens, i.e. worse than doing nothing. Only `--disallowed-tools` removes.
 */

import type { Backend, BackendEvent, LaunchSpec, ParseState } from "./types.js";
import { MCP_SERVER, stripMcpPrefix } from "./types.js";

/**
 * Every built-in worth naming, plus room for the ones a given build adds.
 *
 * Disallowing a tool that does not exist in this build is free, so the list
 * errs long: a name missing from it is a tool definition back in the prompt,
 * which is the expensive failure. It is not the security boundary — Astra's
 * own permissions are — it is a token budget.
 */
const BUILT_IN_TOOLS = [
  "Task", "Bash", "BashOutput", "KillShell", "Edit", "Write", "Read", "NotebookEdit",
  "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite", "SlashCommand", "Skill",
  "ExitPlanMode", "EnterPlanMode", "ListMcpResources", "ReadMcpResource", "PowerShell",
  "Artifact", "AskUserQuestion", "SendUserFile", "ReportFindings", "Monitor",
  "CronCreate", "CronDelete", "CronList", "DesignSync", "EnterWorktree", "ExitWorktree",
  "PushNotification", "RemoteTrigger", "ScheduleWakeup", "SendMessage", "SearchSkills",
  "ListSkills", "SearchPlugins", "ListPlugins", "SuggestPluginInstall", "ToolSearch",
  "TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "TaskOutput", "TaskStop", "Workflow",
];

interface StreamLine {
  type?: string;
  subtype?: string;
  event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
  message?: {
    model?: string;
    content?: { type?: string; text?: string; id?: string; name?: string; input?: unknown }[];
  };
  usage?: Record<string, number>;
  total_cost_usd?: number;
  rate_limit_info?: Record<string, unknown>;
  is_error?: boolean;
  result?: string;
}

export const claudeBackend: Backend = {
  id: "claude",
  label: "Claude Code",
  versionArgs: ["--version"],

  mcpConfig(shimPath, toolsFile) {
    return { mcpServers: { [MCP_SERVER]: { command: process.execPath, args: [shimPath, toolsFile] } } };
  },

  build({ system, prompt, model, effort, mcpConfigFile, extraArgs }): LaunchSpec {
    const args = [
      "-p",
      // stream-json is refused without --verbose. The CLI says so; it is not
      // a suggestion and not a logging level, just a required companion flag.
      "--verbose",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--strict-mcp-config",
      "--system-prompt", system,
      "--disallowed-tools", BUILT_IN_TOOLS.join(","),
    ];
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    if (mcpConfigFile) {
      args.push("--mcp-config", mcpConfigFile);
      // The tools are Astra's, and Astra has already decided what may run:
      // its own confirmation dialog fires when it executes the call we hand
      // back. A second prompt here would be one nobody can see or answer,
      // and the shim never runs anything in any case.
      args.push("--permission-mode", "bypassPermissions");
    }
    args.push(...extraArgs);
    return { args, stdin: prompt };
  },

  parseLine(line, state): BackendEvent[] {
    let data: StreamLine;
    try {
      const parsed: unknown = JSON.parse(line);
      // `JSON.parse("null")` returns null rather than throwing, and a bare
      // `null` on stdout is a line a CLI can legally print.
      if (!parsed || typeof parsed !== "object") return [];
      data = parsed as StreamLine;
    } catch {
      return [];
    }
    const out: BackendEvent[] = [];

    switch (data.type) {
      case "stream_event": {
        const delta = data.event?.delta;
        if (delta?.type === "text_delta" && delta.text) {
          state.sawTextDelta = true;
          out.push({ kind: "text", text: delta.text });
        } else if (delta?.type === "thinking_delta" && delta.thinking) {
          out.push({ kind: "thinking", text: delta.thinking });
        }
        break;
      }

      case "assistant": {
        // `<synthetic>` is Claude Code speaking for itself, not the model: a
        // bad `--model` comes back this way, as an assistant turn reading
        // "There's an issue with the selected model". Yielding it would put
        // the CLI's error in Astra's mouth and then throw a second one when
        // `result` arrives. The `result` error is the honest single signal.
        if (data.message?.model === "<synthetic>") break;
        for (const block of data.message?.content ?? []) {
          if (block.type === "tool_use") {
            out.push({
              kind: "toolCall",
              id: block.id ?? "",
              name: stripMcpPrefix(block.name ?? ""),
              argumentsJson: JSON.stringify(block.input ?? {}),
            });
          } else if (block.type === "text" && block.text && !state.sawTextDelta) {
            // Only when deltas never arrived, or this repeats what was streamed.
            out.push({ kind: "text", text: block.text });
          }
        }
        break;
      }

      case "rate_limit_event": {
        const info = data.rate_limit_info ?? {};
        if (info.status && info.status !== "allowed") {
          const resets = typeof info.resetsAt === "number"
            ? ` Resets at ${new Date(info.resetsAt * 1000).toISOString()}.`
            : "";
          out.push({ kind: "rateLimit", detail: `${info.rateLimitType ?? "usage"}: ${info.status}.${resets}` });
        }
        break;
      }

      case "result": {
        const usage = data.usage ?? {};
        const tokens =
          (usage.input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.output_tokens ?? 0);
        out.push({ kind: "usage", tokens, costUsd: data.total_cost_usd ?? 0 });
        if (data.is_error) {
          out.push({ kind: "error", message: data.result || `Claude Code failed (${data.subtype ?? "unknown"})` });
        }
        break;
      }
    }
    return out;
  },
};
