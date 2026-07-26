/**
 * F2 measurement patch (2/2) — per-call receipt.
 *
 * WHY THIS EXISTS
 *
 * A measurement harness cannot prove a run is valid unless it can see what the
 * engine actually resolved for that specific call. Today nothing exposes it:
 * `eval_candidates` persists only detail/vector/expansion/column, and the CLI
 * formatter drops the meta entirely. So "the cache was off" and "the config
 * read failed and silently fell back to on" look identical from outside.
 *
 * WHAT IT PROMISES, AND WHAT IT DOES NOT
 *
 *   results + their order : IDENTICAL, always. The sink never touches the
 *                           result array, stdout, or the returned meta, and
 *                           every failure is swallowed.
 *   wall time             : MAY INCREASE. Writing a receipt costs CPU, and a
 *                           durable sink costs I/O. "Durable" and "zero timing
 *                           effect" cannot both be true, so we claim only the
 *                           first and measure the second.
 *
 * OFF BY DEFAULT. With `GBRAIN_CALL_RECEIPT_PATH` unset — i.e. in production —
 * `emitCallReceipt` returns before doing any work at all. The lab turns it on
 * per invocation; nobody else pays for it.
 *
 * TWO RESOLUTIONS, AND WHY `inner` IS OPTIONAL
 *
 * A query resolves the search mode twice: once in the cache wrapper (outer) and
 * once inside the hybrid search (inner). But a cache HIT returns before the
 * inner search is ever reached — so on a hit there IS no inner resolution.
 * The receipt therefore distinguishes three states, and the harness must not
 * collapse them:
 *
 *   inner present            → the inner resolution ran, here is what it saw
 *   inner absent + hit       → expected: the hit short-circuited before it
 *   inner absent + non-hit   → ANOMALY: something failed on the way
 *
 * Collapsing "did not happen" into "happened and reported nothing" is exactly
 * the ambiguous-zero this whole harness exists to eliminate.
 */

import { appendFileSync } from 'fs';

/** One resolution of the search mode, as the engine actually resolved it. */
export interface ReceiptResolution {
  /** Which of the two resolutions this is. */
  stage: 'outer' | 'inner';
  /**
   * The effective knobs hash. The harness seeds cache rows under this value.
   *
   * OPTIONAL because only the outer resolution computes one as part of its
   * normal work; the inner one is derived for the receipt and may fail. An
   * ABSENT hash means "could not be determined", never "matched" — a control
   * that compares hashes must treat absence as unverifiable, not as agreement.
   */
  knobs_hash?: string;
  /** Effective cache decision for this call. */
  cache_enabled: boolean;
  /**
   * Whether the config read succeeded, or fell back to defaults. `getConfig`
   * swallows its errors and reports "not configured", so a fallback is
   * indistinguishable from an honest default unless we say so here.
   */
  config_read: 'ok' | 'fallback';
  /**
   * WHICH reads were swallowed, when `config_read` is `fallback`. Without the
   * key names a fallback says "something was masked" and leaves the harness to
   * guess whether it was the one that matters (`search.cache.enabled`).
   */
  config_read_failures?: string[];
  /** Effective source scope for this call. */
  scope?: string;
  /** Embedding column actually resolved (not the configured default). */
  embedding_column?: string;
  /** Cache similarity threshold and TTL in force. */
  similarity_threshold?: number;
  ttl_seconds?: number;
  /**
   * Resolved search limit. Not a cache knob — it is in here because it decides
   * WHICH result comes first, not just how many: `innerLimit = limit * 2` is
   * applied before candidate generation in both arms. Two runs with different
   * limits are not comparable, and the receipt is where that becomes visible.
   */
  search_limit?: number;
  /** Why the cache was skipped, if it was. Empty array = not skipped. */
  skip_reasons: string[];
  /** Whether a cache lookup was attempted, and how it went. */
  lookup_attempted: boolean;
  lookup_outcome?: 'hit' | 'miss' | 'not_attempted';
  /**
   * When no lookup was attempted, WHY. "The cache was off" and "the query
   * embed timed out" both produce zero lookups and identical results; only
   * the first one means the run proved anything about the cache.
   */
  lookup_blocked_by?: 'skip_cache' | 'no_embedding_provider' | 'embed_failed' | 'no_embedding';
}

export interface CallReceipt {
  /** Ties every resolution of one call together. */
  call_id: string;
  ts_utc: string;
  query: string;
  /** Measured BEFORE the receipt is emitted, so the sink can't inflate it. */
  latency_ms?: number;
  /**
   * How the call ended. This is what makes the three `inner` states decidable
   * without inference:
   *
   *   `hit`   + no inner → expected, the hit short-circuited
   *   `fresh` + no inner → ANOMALY
   *   `error`           → the call threw; the receipt is the only trace left
   */
  call_outcome?: 'hit' | 'fresh' | 'error';
  /** Error message when `call_outcome` is `error`. The call still throws. */
  error?: string;
  /**
   * Whether the fresh path tried to write the result back to the cache, and
   * which guard stopped it if not. The harness's first control seeds a cache
   * row by running a normal query and watching the row count go 0 → 1; when
   * no row appears, this is what separates "the detector is blind" from "the
   * probe was never eligible to be cached" — a diagnosis that otherwise gets
   * made by guessing.
   *
   * `attempted: true` means the store call was issued, not that it succeeded:
   * the write is fire-and-forget with its error swallowed.
   */
  writeback?: {
    attempted: boolean;
    blocked_by?: string[];
  };
  resolutions: ReceiptResolution[];
}

/** Sink path, read once. Unset ⇒ receipts are disabled entirely. */
function sinkPath(): string | undefined {
  const p = process.env.GBRAIN_CALL_RECEIPT_PATH;
  return p && p.length > 0 ? p : undefined;
}

export function receiptsEnabled(): boolean {
  return sinkPath() !== undefined;
}

/** Fresh call id. Cheap, and only computed when receipts are on. */
export function newCallId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * Append one receipt. Best-effort by construction:
 *
 *  - returns immediately when the sink is not configured;
 *  - every failure is swallowed — a broken sink must never change what the
 *    caller returns, which is what the negative-control test proves;
 *  - writes to its own file, never to stdout/stderr, so it cannot contaminate
 *    the output the harness parses.
 */
export function emitCallReceipt(receipt: CallReceipt): void {
  const path = sinkPath();
  if (!path) return; // production: zero work
  try {
    appendFileSync(path, `${JSON.stringify(receipt)}\n`);
  } catch {
    // Swallowed on purpose. A receipt is evidence, not a dependency: losing it
    // must degrade the run to "unverifiable", never change its result. The
    // harness detects the loss by the receipt's absence, not by an exception
    // reaching the caller.
  }
}
