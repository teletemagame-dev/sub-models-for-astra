/**
 * The spend ledger.
 *
 * A subscription does not bill you, it throttles you, and it does so on a
 * window you cannot see. This file is the part you *can* see: every turn this
 * plugin runs is appended here with what it cost, and the limits in the
 * settings are enforced against it before the next one starts.
 *
 * The windows roll. "Per day" means the last 24 hours, not since midnight —
 * a calendar limit hands you a cliff at midnight and a free-for-all at 00:01,
 * which is exactly the shape that empties a weekly quota in one evening.
 *
 * Everything except `loadLedger`/`saveLedger` is pure, so the interesting
 * behaviour is testable without a clock or a disk.
 */

import fs from "node:fs";
import path from "node:path";
import type { Settings } from "./config.js";

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export interface Turn {
  /** Epoch milliseconds. */
  at: number;
  /** Input + output, as the backend reported it. 0 when it reported nothing. */
  tokens: number;
}

export interface Ledger {
  turns: Turn[];
}

export interface Usage {
  turnsHour: number;
  turnsDay: number;
  tokensDay: number;
}

export interface Verdict {
  allowed: boolean;
  /** Why it was refused — user-facing, and the text the model never sees. */
  reason?: string;
  /** Set when a limit is spent but the action is `warn`, or when close to one. */
  warning?: string;
  /** How long until the tightest breached window frees up. */
  retryAfterMs?: number;
}

export function emptyLedger(): Ledger {
  return { turns: [] };
}

/** Drop everything outside the widest window we ever ask about. */
export function prune(ledger: Ledger, now: number): Ledger {
  return { turns: ledger.turns.filter((t) => now - t.at < DAY_MS) };
}

export function measure(ledger: Ledger, now: number): Usage {
  let turnsHour = 0;
  let turnsDay = 0;
  let tokensDay = 0;
  for (const turn of ledger.turns) {
    const age = now - turn.at;
    if (age >= DAY_MS) continue;
    turnsDay++;
    tokensDay += turn.tokens;
    if (age < HOUR_MS) turnsHour++;
  }
  return { turnsHour, turnsDay, tokensDay };
}

interface Breach {
  text: string;
  retryAfterMs: number;
}

/** Human wording for one exhausted limit, including when it frees up again. */
function refusal(what: string, limit: number, windowMs: number, oldest: number, now: number): Breach {
  const retryAfterMs = Math.max(0, windowMs - (now - oldest));
  const mins = Math.ceil(retryAfterMs / 60000);
  const when = mins >= 60 ? `${Math.ceil(mins / 60)} h` : `${mins} min`;
  return {
    text: `${what} limit reached (${limit}). The oldest turn in the window ages out in about ${when}.`,
    retryAfterMs,
  };
}

/**
 * Decide whether one more turn may run.
 *
 * The token limit is checked against what has *already* been spent: a turn's
 * own cost is unknowable until it has run, so a limit can be overshot by one
 * turn. Bounding that properly would mean refusing turns that would have fit.
 */
export function check(settings: Settings, ledger: Ledger, now: number): Verdict {
  const used = measure(ledger, now);
  const inWindow = (ms: number) =>
    ledger.turns.filter((t) => now - t.at < ms).map((t) => t.at).sort((a, b) => a - b)[0] ?? now;

  const breaches: Breach[] = [];
  if (settings.turnsPerHour > 0 && used.turnsHour >= settings.turnsPerHour) {
    breaches.push(refusal("Hourly turn", settings.turnsPerHour, HOUR_MS, inWindow(HOUR_MS), now));
  }
  if (settings.turnsPerDay > 0 && used.turnsDay >= settings.turnsPerDay) {
    breaches.push(refusal("Daily turn", settings.turnsPerDay, DAY_MS, inWindow(DAY_MS), now));
  }
  if (settings.tokensPerDay > 0 && used.tokensDay >= settings.tokensPerDay) {
    breaches.push(
      refusal(`Daily token (${used.tokensDay} spent)`, settings.tokensPerDay, DAY_MS, inWindow(DAY_MS), now),
    );
  }

  if (breaches.length > 0) {
    const text = breaches.map((b) => b.text).join(" ");
    // The soonest one: the caller only has to wait for the tightest window.
    const retryAfterMs = Math.min(...breaches.map((b) => b.retryAfterMs));
    return settings.onLimit === "warn"
      ? { allowed: true, warning: text }
      : { allowed: false, reason: text, retryAfterMs };
  }

  // Silence up to 80% and a word after it. A limit that only speaks up at the
  // moment it stops you is a limit you find out about at the worst time.
  const near = (spent: number, limit: number, what: string) =>
    limit > 0 && spent >= limit * 0.8 ? `${what}: ${spent}/${limit}.` : "";
  const warning = [
    near(used.turnsHour, settings.turnsPerHour, "turns this hour"),
    near(used.turnsDay, settings.turnsPerDay, "turns today"),
    near(used.tokensDay, settings.tokensPerDay, "tokens today"),
  ]
    .filter(Boolean)
    .join(" ");

  return warning ? { allowed: true, warning } : { allowed: true };
}

export function record(ledger: Ledger, at: number, tokens: number): Ledger {
  return { turns: [...ledger.turns, { at, tokens: Math.max(0, Math.round(tokens)) }] };
}

/** A ledger that cannot be read is an empty one — never a crashed turn. */
export function loadLedger(file: string): Ledger {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return emptyLedger();
    const turns = (parsed as { turns?: unknown }).turns;
    if (!Array.isArray(turns)) return emptyLedger();
    return {
      turns: turns
        .filter((t): t is Turn => !!t && typeof t === "object")
        .map((t) => ({ at: Number((t as Turn).at) || 0, tokens: Number((t as Turn).tokens) || 0 }))
        .filter((t) => t.at > 0),
    };
  } catch {
    return emptyLedger();
  }
}

/** Best effort: a turn that worked must not fail because the disk did. */
export function saveLedger(file: string, ledger: Ledger): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(ledger), "utf8");
  } catch {
    /* the limit degrades to in-memory for this session; the turn still ran */
  }
}
