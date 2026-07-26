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
import { createHash } from 'crypto';

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
  /**
   * F2 measurement patch (2/2c) — the SAME knobs with the cache decision
   * normalized out, so the two resolutions are actually comparable.
   *
   * `knobs_hash` is NOT comparable across stages, and a control that compares
   * it is wrong by construction: the outer folds the per-call `use_cache` into
   * its resolution and the inner does not, so a legitimate `use_cache:false`
   * run makes the two hashes differ every single time. A harness rule reading
   * "hashes differ ⇒ invalid" would therefore throw away exactly the condition
   * the experiment needs — which is what the eighth audit caught.
   *
   * This field answers the question that rule was actually trying to ask:
   * *did the two resolutions agree on everything else?* Compare THIS across
   * stages, and compare `cache_enabled` against the condition separately.
   *
   * F2 (2/2e) — the ninth audit's blocker 1: the first version of this field
   * was just `knobsHash` with the cache decision normalized out, and
   * `knobsHash` OMITS effective state that changes the pipeline. So two stages
   * could agree on this hash having resolved different things, and rule 6 would
   * read that agreement as "everything else matched". It is now built by
   * `sharedKnobsDigest`, which folds the omissions in — see that function for
   * the list and for why an incomplete input yields ABSENT rather than a hash.
   */
  shared_knobs_hash?: string;
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
  /**
   * F2 (2/2e) — the three pieces of effective state `knobsHash` omits, carried
   * individually as well as folded into `shared_knobs_hash`.
   *
   * The hash makes rule 6 ONE comparison; these make a mismatch DIAGNOSABLE.
   * With only the hash, two stages that disagree produce "the hashes differ"
   * and the operator has to bisect the engine to learn why — which in practice
   * means the run gets discarded without a cause, and a systematic divergence
   * looks like noise.
   *
   * `column_dimensions` + `column_type`: `knobsHash` folds the column NAME and
   * provider model, not its geometry. Two stages can resolve the same name to
   * different dim/type (the registry is DB-plane state, read once per stage)
   * and that is a different vector space, not a different label.
   */
  column_dimensions?: number;
  column_type?: string;
  /**
   * Effective adaptive-return decision. Resolved SEPARATELY in each stage from
   * its own config read, and absent from `knobsHash` entirely (the cache skips
   * instead of segregating). A stage that trimmed the set and one that did not
   * are not comparable, and nothing else in the receipt says which happened.
   */
  adaptive_return?: boolean;
  /**
   * Digest of the reranker config the pipeline would actually apply —
   * `opts.reranker ?? mode bundle`, which is what `hybridSearch` reads at the
   * rerank step. `knobsHash` folds only the BUNDLE's reranker, so on a per-call
   * `reranker` override the outer hashed one config while the inner applied
   * another, and the shared hash matched anyway.
   */
  reranker_effective?: string;
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
  /**
   * Whether a cache lookup was attempted, and how it went.
   *
   * `error` exists because the lookup swallows every exception into
   * `{hit:false}`. Without it, a failed lookup reports as a healthy `miss` —
   * and a control asserting "with the cache off the sentinel is not served"
   * would pass on a run where the cache was ON and merely broken. That is the
   * false green this whole instrument exists to prevent, so it gets its own
   * outcome rather than a flag someone has to remember to read.
   */
  lookup_attempted: boolean;
  lookup_outcome?: 'hit' | 'miss' | 'error' | 'not_attempted';
  /** The swallowed error, when `lookup_outcome` is `error`. */
  lookup_error?: string;
  /**
   * Identity of the cache row that served a hit. Lets a control prove a second
   * hit came from the SAME row instead of a replacement written in between.
   */
  cache_row_id?: string;
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

/**
 * F2 (2/2e) — digest of the reranker config the pipeline would ACTUALLY apply.
 *
 * `hybridSearch` resolves the reranker as `opts.reranker ?? bundle`, taking the
 * per-call object WHOLE — a partial override leaves the other fields undefined
 * rather than falling back field-by-field. This digest reproduces that exactly,
 * including the undefineds, because the harness needs what the pipeline uses,
 * not what a well-formed config would have said.
 *
 * Structural parameter types on purpose: this module is the sink and stays free
 * of search-internal imports.
 */
export function rerankerDigest(
  perCall:
    | {
        enabled?: boolean;
        model?: string;
        topNIn?: number;
        topNOut?: number | null;
        timeoutMs?: number;
        /** A per-call reranker implementation. Its PRESENCE is effective state. */
        rerankerFn?: unknown;
      }
    | undefined,
  bundle: {
    reranker_enabled: boolean;
    reranker_model: string;
    reranker_top_n_in: number;
    reranker_top_n_out?: number | null;
    reranker_timeout_ms: number;
  },
): string {
  const eff = perCall ?? {
    enabled: bundle.reranker_enabled,
    model: bundle.reranker_model,
    topNIn: bundle.reranker_top_n_in,
    topNOut: bundle.reranker_top_n_out,
    timeoutMs: bundle.reranker_timeout_ms,
    rerankerFn: undefined,
  };
  // `null` and `undefined` are DIFFERENT states here and must not collapse:
  // `topNOut: null` is an explicit "no output cap", `undefined` is "the caller
  // said nothing" — and on a partial per-call override the second one is what
  // the pipeline actually uses.
  const v = (x: unknown) => (x === undefined ? 'none' : x === null ? 'null' : String(x));
  return [
    `src=${perCall ? 'per_call' : 'bundle'}`,
    `en=${eff.enabled ? 1 : 0}`,
    `m=${v(eff.model)}`,
    `in=${v(eff.topNIn)}`,
    `out=${v(eff.topNOut)}`,
    `t=${v(eff.timeoutMs)}`,
    // An injected reranker replaces the scorer entirely — a run with one is not
    // comparable to a run without it, whatever the other fields say.
    `fn=${eff.rerankerFn === undefined ? 0 : 1}`,
  ].join(',');
}

/**
 * F2 (2/2e) — the comparable hash for rule 6, built from the normalized
 * effective hash PLUS the state `knobsHash` leaves out.
 *
 * 🔴 RETURNS `undefined` WHEN ANY COMPONENT IS UNKNOWN, and that is the whole
 * point. Hashing a missing value as a literal `'none'` would make two stages
 * that BOTH failed to resolve it agree — a hash that says "equivalent" about a
 * pair where neither side knows what it ran. Absent means unverifiable; the
 * harness must treat it as invalidating, never as agreement. (The ninth audit
 * caught the weaker version of exactly this: a gate that could report equality
 * it had not established.)
 *
 * `baseHash` must already have the cache decision normalized out — this
 * function does not know about `cache_enabled` and does not touch it.
 */
export function sharedKnobsDigest(
  baseHash: string | undefined,
  extra: {
    columnDimensions?: number;
    columnType?: string;
    adaptiveReturn?: boolean;
    rerankerEffective?: string;
  },
): string | undefined {
  if (
    baseHash === undefined ||
    extra.columnDimensions === undefined ||
    extra.columnType === undefined ||
    extra.adaptiveReturn === undefined ||
    extra.rerankerEffective === undefined
  ) {
    return undefined;
  }
  const h = createHash('sha256');
  h.update(
    [
      'sv=1',
      `k=${baseHash}`,
      `dim=${extra.columnDimensions}`,
      `ctype=${extra.columnType}`,
      `ar=${extra.adaptiveReturn ? 1 : 0}`,
      `rr=${extra.rerankerEffective}`,
    ].join('|'),
  );
  return h.digest('hex').slice(0, 16);
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
