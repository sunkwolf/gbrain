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
import type { RerankerExecution } from './rerank.ts';
import {
  KNOBS_HASH_VERSION,
  type KnobsHashContext,
  type ResolvedSearchKnobs,
} from './mode.ts';

export const CALL_RECEIPT_VERSION = '1.3' as const;
export const SHARED_DIGEST_VERSION = 1 as const;

export type SharedDigestComponent =
  | { name: string; type: 'string'; value: string }
  | { name: string; type: 'integer'; value: number }
  | { name: string; type: 'boolean'; value: boolean }
  | { name: string; type: 'decimal'; value: string }
  | { name: string; type: 'null'; value: null }
  | { name: string; type: 'string_list'; value: string[] };

export interface SharedDigestMaterial {
  /** Ordered, typed components. Array order is part of the digest contract. */
  components: SharedDigestComponent[];
}

export interface SharedDigestEvidence {
  shared_digest_version: typeof SHARED_DIGEST_VERSION;
  shared_digest_material: SharedDigestMaterial;
  /** Full lowercase SHA-256 over canonicalSharedDigestMaterial(...). */
  shared_knobs_hash: string;
}

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
  /** Public digest contract. All three fields are emitted or all are absent. */
  shared_digest_version?: typeof SHARED_DIGEST_VERSION;
  shared_digest_material?: SharedDigestMaterial;
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
  /**
   * F2 (2/2f) — the FILE plane, reported separately from `config_read`.
   *
   * `config_read` answers "were reads masked?" as one bit over both planes.
   * This answers a question that bit structurally cannot: WHICH plane, and in
   * the file plane's case, whether the file was absent (honest — the default
   * install) or present-and-broken (a fallback that silently changes the
   * embedding model, dimensions and column registry the run used).
   *
   * `absent` and `not_read` are NOT failures and do not set `config_read` to
   * `fallback`. They are still reported, because a harness comparing two
   * machines needs to know the lab had no config file where production has one.
   */
  config_file_read?: 'not_read' | 'ok' | 'absent' | 'unreadable' | 'parse_error' | 'migration_error';
  /** The swallowed file-plane error, when `config_file_read` is a failure. */
  config_file_error?: string;
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
   * F2 (2/2h) — the FULL effective adaptive-return policy, not just its switch.
   *
   * The tenth audit's blocker: `resolveAdaptiveReturn` resolves FOUR values —
   * `enabled`, `entityMax`, `otherMax`, `minKeep` — and the three caps decide
   * how many results survive the trim. Folding only `enabled` left a real false
   * equivalence: Codex pinned the inner's three caps to 1, which changes the
   * effective policy, and the wiring file stayed green at 19/0.
   *
   * Format `on:entity/other/min` when enabled, `off` when not. The caps are
   * omitted while disabled ON PURPOSE: `applyAdaptiveReturn` returns early
   * before reading them, so two gate-off stages with different caps really are
   * equivalent, and folding the caps anyway would invalidate runs over a
   * difference that changed nothing.
   */
  adaptive_return_policy?: string;
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
  /** Contract version of this emitted receipt. */
  receipt_version: typeof CALL_RECEIPT_VERSION;
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
  /** What the reranker stage actually did, not what its config requested. */
  reranker_execution: RerankerExecution;
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
 * F2 (2/2h) — the effective adaptive-return policy, rendered for the digest.
 *
 * `enabled` alone is not the policy: the three caps decide how many results
 * survive the trim, so two stages agreeing on the switch and differing on the
 * caps produce different result sets from the same query. That gap was a real
 * false equivalence — see `ReceiptResolution.adaptive_return_policy`.
 *
 * Disabled ⇒ `off`, with the caps deliberately dropped: the trim returns before
 * reading them, so gate-off stages with different caps ARE equivalent. Folding
 * them anyway would invalidate runs over a difference that changed nothing,
 * which is the opposite failure and just as expensive.
 */
export function adaptiveReturnDigest(cfg: {
  enabled: boolean;
  entityMax: number;
  otherMax: number;
  minKeep: number;
}): string {
  return cfg.enabled ? `on:${cfg.entityMax}/${cfg.otherMax}/${cfg.minKeep}` : 'off';
}

/**
 * Contract v1.3 / HSH-002 — the comparable hash for rule 6, built from the
 * complete typed effective state instead of from an opaque base hash.
 *
 * 🔴 RETURNS `undefined` WHEN ANY COMPONENT IS UNKNOWN, and that is the whole
 * point. Hashing a missing value as a literal `'none'` would make two stages
 * that BOTH failed to resolve it agree — a hash that says "equivalent" about a
 * pair where neither side knows what it ran. Absent means unverifiable; the
 * harness must treat it as invalidating, never as agreement. (The ninth audit
 * caught the weaker version of exactly this: a gate that could report equality
 * it had not established.)
 *
 * Cache is normalized to false in the public material. The product's 16-char
 * cache key remains separate and unchanged; this 64-char digest is evidence.
 */
export function canonicalSharedDigestMaterial(
  version: number,
  material: SharedDigestMaterial,
): string {
  // The property order below is normative. Components are an ordered array,
  // decimals are fixed-width strings, and all other values have explicit type
  // tags. Python uses the same compact UTF-8 JSON form in HSH-002.
  return JSON.stringify({ shared_digest_version: version, components: material.components });
}

/** Build the complete, public preimage for HSH-002. */
export function sharedKnobsDigest(
  knobs: ResolvedSearchKnobs | undefined,
  ctx: KnobsHashContext | undefined,
  extra: {
    columnDimensions?: number;
    columnType?: string;
    /** The FULL effective policy from `adaptiveReturnDigest`, not just the switch. */
    adaptiveReturn?: string;
    rerankerEffective?: string;
  },
): SharedDigestEvidence | undefined {
  if (
    knobs === undefined ||
    extra.columnDimensions === undefined ||
    extra.columnType === undefined ||
    extra.adaptiveReturn === undefined ||
    extra.rerankerEffective === undefined
  ) {
    return undefined;
  }

  const decimal = (name: string, value: number, places: number): SharedDigestComponent => ({
    name,
    type: 'decimal',
    value: value.toFixed(places),
  });
  const nullableDecimal = (
    name: string,
    value: number | undefined,
    places: number,
  ): SharedDigestComponent => value === undefined
    ? { name, type: 'null', value: null }
    : decimal(name, value, places);
  const nullableInteger = (name: string, value: number | null | undefined): SharedDigestComponent =>
    value === undefined || value === null
      ? { name, type: 'null', value: null }
      : { name, type: 'integer', value };
  const nullableString = (name: string, value: string | undefined): SharedDigestComponent =>
    value === undefined
      ? { name, type: 'null', value: null }
      : { name, type: 'string', value };

  const material: SharedDigestMaterial = {
    components: [
      { name: 'knobs_hash_version', type: 'integer', value: KNOBS_HASH_VERSION },
      { name: 'resolved_mode', type: 'string', value: knobs.resolved_mode },
      // Shared means cache-neutral. Carry the normalized value explicitly so
      // the preimage proves the normalization instead of merely documenting it.
      { name: 'cache_enabled', type: 'boolean', value: false },
      decimal('cache_similarity_threshold', knobs.cache_similarity_threshold, 4),
      { name: 'cache_ttl_seconds', type: 'integer', value: knobs.cache_ttl_seconds },
      { name: 'intent_weighting', type: 'boolean', value: knobs.intentWeighting },
      nullableInteger('token_budget', knobs.tokenBudget),
      { name: 'expansion', type: 'boolean', value: knobs.expansion },
      { name: 'search_limit', type: 'integer', value: knobs.searchLimit },
      { name: 'reranker_bundle_enabled', type: 'boolean', value: knobs.reranker_enabled },
      { name: 'reranker_bundle_model', type: 'string', value: knobs.reranker_model },
      { name: 'reranker_bundle_top_n_in', type: 'integer', value: knobs.reranker_top_n_in },
      nullableInteger('reranker_bundle_top_n_out', knobs.reranker_top_n_out),
      { name: 'reranker_bundle_timeout_ms', type: 'integer', value: knobs.reranker_timeout_ms },
      nullableDecimal('floor_ratio', knobs.floor_ratio, 4),
      decimal('cross_modal_both_text_weight', knobs.cross_modal_both_text_weight, 2),
      decimal('cross_modal_both_image_weight', knobs.cross_modal_both_image_weight, 2),
      decimal('image_query_text_refinement_weight', knobs.image_query_text_refinement_weight, 2),
      decimal('image_query_image_refinement_weight', knobs.image_query_image_refinement_weight, 2),
      { name: 'unified_multimodal', type: 'boolean', value: knobs.unified_multimodal },
      { name: 'unified_multimodal_only', type: 'boolean', value: knobs.unified_multimodal_only },
      { name: 'cross_modal_llm_intent', type: 'boolean', value: knobs.cross_modal_llm_intent },
      { name: 'embedding_column', type: 'string', value: ctx?.embeddingColumn ?? 'embedding' },
      { name: 'embedding_model', type: 'string', value: ctx?.embeddingModel ?? 'default' },
      { name: 'graph_signals', type: 'boolean', value: knobs.graph_signals },
      nullableString('schema_pack', ctx?.schemaPack),
      nullableString('schema_pack_version', ctx?.schemaPackVersion),
      { name: 'contextual_retrieval', type: 'string', value: knobs.contextual_retrieval },
      { name: 'contextual_retrieval_disabled', type: 'boolean', value: knobs.contextual_retrieval_disabled },
      nullableDecimal('title_boost', knobs.title_boost, 4),
      { name: 'autocut', type: 'boolean', value: knobs.autocut },
      decimal('autocut_jump', knobs.autocut_jump ?? 0.2, 2),
      { name: 'relational_retrieval', type: 'boolean', value: knobs.relationalRetrieval },
      { name: 'relational_retrieval_depth', type: 'integer', value: knobs.relational_retrieval_depth ?? 2 },
      ctx?.hardExcludes === undefined
        ? { name: 'hard_excludes', type: 'null', value: null }
        : { name: 'hard_excludes', type: 'string_list', value: [...ctx.hardExcludes].sort() },
      { name: 'column_dimensions', type: 'integer', value: extra.columnDimensions },
      { name: 'column_type', type: 'string', value: extra.columnType },
      { name: 'adaptive_return_policy', type: 'string', value: extra.adaptiveReturn },
      { name: 'reranker_effective', type: 'string', value: extra.rerankerEffective },
    ],
  };
  const h = createHash('sha256');
  h.update(canonicalSharedDigestMaterial(SHARED_DIGEST_VERSION, material), 'utf8');
  return {
    shared_digest_version: SHARED_DIGEST_VERSION,
    shared_digest_material: material,
    shared_knobs_hash: h.digest('hex'),
  };
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
