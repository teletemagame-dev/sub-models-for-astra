/**
 * The test bundle's entry point.
 *
 * `src/index.ts` exports the plugin and nothing else, which is right for the
 * thing the daemon loads and useless for testing the parts underneath it. This
 * file exists only so the suite can reach them; it is never built into `dist/`.
 */

export { app } from "./index.js";
export * as budget from "./budget.js";
export { readSettings, defaultLedgerPath, resolveModel, CLAUDE_MODELS } from "./config.js";
export { render, bridgeNotes } from "./transcript.js";
export { claudeBackend } from "./backends/claude.js";
export { codexBackend } from "./backends/codex.js";
export { newParseState, normaliseEffort, stripMcpPrefix } from "./backends/types.js";
export { run, CliMissing } from "./runner.js";
export { resolveLauncher } from "./launcher.js";
export { diagnose, readable } from "./diagnose.js";
export { INSTALL_PLANS, SETUP_TARGETS, LABELS, probe } from "./setup.js";
