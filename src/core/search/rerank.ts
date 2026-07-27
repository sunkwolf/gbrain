/**
 * v0.35.0.0+ — reranker call-site abstraction.
 *
 * Slots into hybridSearch after `dedupResults()` and before
 * `enforceTokenBudget()`. Takes the top `topNIn` candidates by current RRF
 * order, sends them to `gateway.rerank()`, and re-orders by the
 * cross-encoder's relevance score. The un-reranked long tail keeps its
 * original RRF order — preserves recall vs. truncating to topNIn.
 *
 * Fail-open posture: every error class (auth, network, timeout, rate-limit,
 * payload-too-large, unknown) logs to the rerank-audit JSONL and returns
 * the original RRF order unchanged. Search reliability beats reranker
 * quality; a flaky upstream must never break search.
 *
 * Caller (hybridSearch) decides whether the reranker fires via
 * `opts.reranker?.enabled`. Mode-bundle resolution defaults this to `true`
 * for tokenmax and `false` for conservative/balanced.
 */

import { createHash } from 'crypto';
import type { SearchResult } from '../types.ts';
import { rerank as gatewayRerank, RerankError, type RerankInput, type RerankResult } from '../ai/gateway.ts';
import { logRerankFailure, type RerankFailureReason } from '../rerank-audit.ts';

export interface RerankerOpts {
  enabled: boolean;
  /** How many of the top results to send to the reranker (default 30). */
  topNIn: number;
  /** Truncate the reranked output to this many (null = no truncate). */
  topNOut: number | null;
  /** Provider:model override. When undefined, gateway uses configured default. */
  model?: string;
  /** Per-call timeout in ms (default 5000 — propagates to gateway.rerank). */
  timeoutMs?: number;
  /**
   * Test seam — when set, applyReranker calls this instead of gateway.rerank.
   * Production must NEVER set this.
   */
  rerankerFn?: (input: RerankInput) => Promise<RerankResult[]>;
}

export interface RerankerCandidateEvidence {
  /** One-based position at this side of the reranker boundary. */
  rank: number;
  source_id: string;
  slug: string;
  chunk_id: number | null;
}

export interface RerankerOutputEvidence extends RerankerCandidateEvidence {
  /** Null means the reranker did not supply a finite score for this item. */
  rerank_score: number | null;
}

export type RerankerFailureReason =
  | 'auth'
  | 'rate_limit'
  | 'network'
  | 'timeout'
  | 'payload_too_large'
  | 'malformed'
  | 'unknown';

export type RerankerSkipReason =
  | 'no_candidates'
  | 'input_limit_zero'
  | 'embedding_provider_unavailable'
  | 'query_embedding_failed'
  | 'call_error_before_reranker';

interface RerankerExecutionBase {
  input_count: number;
  output_count: number;
  input: RerankerCandidateEvidence[];
  output: RerankerOutputEvidence[];
  /** The HTTP-call duration only. Null means no reranker request happened. */
  duration_ms: number | null;
  /** Null is an explicit observed gap, never the requested model copied over. */
  model_responded: string | null;
  fail_open: boolean;
}

export type RerankerExecution =
  | (RerankerExecutionBase & { status: 'disabled'; fail_open: false })
  | (RerankerExecutionBase & {
      status: 'skipped';
      skip_reason: RerankerSkipReason;
      fail_open: false;
    })
  | (RerankerExecutionBase & { status: 'not_reached_cache_hit'; fail_open: false })
  | (RerankerExecutionBase & { status: 'succeeded'; duration_ms: number; fail_open: false })
  | (RerankerExecutionBase & {
      status: 'failed';
      failure_reason: RerankerFailureReason;
      error: string;
      duration_ms: number;
      fail_open: true;
    });

export function rerankerNotRun(
  status: 'disabled' | 'not_reached_cache_hit',
): RerankerExecution;
export function rerankerNotRun(
  status: 'skipped',
  skipReason: RerankerSkipReason,
): RerankerExecution;
export function rerankerNotRun(
  status: 'disabled' | 'not_reached_cache_hit' | 'skipped',
  skipReason?: RerankerSkipReason,
): RerankerExecution {
  const base: Omit<RerankerExecutionBase, 'fail_open'> & { fail_open: false } = {
    input_count: 0,
    output_count: 0,
    input: [],
    output: [],
    duration_ms: null,
    model_responded: null,
    fail_open: false,
  };
  if (status === 'skipped') return { ...base, status, skip_reason: skipReason! };
  if (status === 'disabled') return { ...base, status };
  return { ...base, status: 'not_reached_cache_hit' };
}

function candidateEvidence(result: SearchResult, rank: number): RerankerCandidateEvidence {
  return {
    rank,
    source_id: result.source_id ?? 'default',
    slug: result.slug,
    chunk_id: typeof result.chunk_id === 'number' ? result.chunk_id : null,
  };
}

function outputEvidence(
  result: SearchResult,
  rank: number,
  score: number | undefined,
): RerankerOutputEvidence {
  return {
    ...candidateEvidence(result, rank),
    rerank_score: Number.isFinite(score) ? score! : null,
  };
}

/** SHA-256 prefix (8 chars) of the query text for privacy-preserving audit. */
function hashQuery(query: string): string {
  return createHash('sha256').update(query, 'utf8').digest('hex').slice(0, 8);
}

/**
 * Reorder the top `topNIn` results by reranker relevance score. The
 * un-reranked tail (any rows past topNIn) preserves its original RRF
 * position — appended after the reordered head in the same order it had
 * coming in.
 *
 * On reranker failure, logs to ~/.gbrain/audit/rerank-failures-* and
 * returns the input array unmodified. Never throws.
 *
 * Empty input passes through immediately (no upstream call).
 */
export async function applyReranker(
  query: string,
  results: SearchResult[],
  opts: RerankerOpts,
  onExecution?: (execution: RerankerExecution) => void,
): Promise<SearchResult[]> {
  const report = (execution: RerankerExecution): void => {
    try {
      onExecution?.(execution);
    } catch {
      // Measurement is evidence, never a dependency of search.
    }
  };
  if (!opts.enabled) {
    report(rerankerNotRun('disabled'));
    return results;
  }
  if (results.length === 0) {
    report(rerankerNotRun('skipped', 'no_candidates'));
    return results;
  }
  // No documents to rerank when topNIn=0 — pass through (defensive; mode
  // bundles never set 0 in practice).
  if (opts.topNIn <= 0) {
    report(rerankerNotRun('skipped', 'input_limit_zero'));
    return results;
  }

  const head = results.slice(0, opts.topNIn);
  const tail = results.slice(opts.topNIn);
  const inputEvidence = head.map((result, index) => candidateEvidence(result, index + 1));

  // Document text — chunk_text is the matched span. Fall back to title if
  // empty (shouldn't happen in practice; defensive). Empty docs would
  // confuse the reranker, but we still send them — the upstream model decides.
  const documents = head.map(r => r.chunk_text || r.title || '');

  let reranked: RerankResult[];
  let modelResponded: string | undefined;
  const callStartedAt = Date.now();
  try {
    const rerankerFn = opts.rerankerFn ?? gatewayRerank;
    reranked = await rerankerFn({
      query,
      documents,
      timeoutMs: opts.timeoutMs,
      ...(opts.model ? { model: opts.model } : {}),
      onResponseMeta: (meta) => {
        modelResponded = meta.modelResponded;
      },
    });
  } catch (err) {
    const reason: RerankFailureReason =
      err instanceof RerankError ? err.reason : 'unknown';
    const errorSummary = err instanceof Error ? err.message : String(err);
    try {
      logRerankFailure({
        model: opts.model ?? 'unknown',
        reason,
        query_hash: hashQuery(query),
        doc_count: documents.length,
        error_summary: errorSummary,
      });
    } catch {
      // Audit logging must never break search.
    }
    report({
      status: 'failed',
      failure_reason: reason,
      error: errorSummary,
      input_count: inputEvidence.length,
      output_count: inputEvidence.length,
      input: inputEvidence,
      output: head.map((result, index) => outputEvidence(result, index + 1, undefined)),
      duration_ms: Math.max(0, Date.now() - callStartedAt),
      model_responded: modelResponded ?? null,
      fail_open: true,
    });
    return results;
  }

  // Defensive: if the reranker returned a malformed shape, pass through.
  if (!Array.isArray(reranked) || reranked.length === 0) {
    report({
      status: 'failed',
      failure_reason: 'malformed',
      error: 'reranker returned no ranked results',
      input_count: inputEvidence.length,
      output_count: inputEvidence.length,
      input: inputEvidence,
      output: head.map((result, index) => outputEvidence(result, index + 1, undefined)),
      duration_ms: Math.max(0, Date.now() - callStartedAt),
      model_responded: modelResponded ?? null,
      fail_open: true,
    });
    return results;
  }

  // Build the reordered head. We keep ONLY indices the reranker returned
  // (so a top_n response with fewer items than head.length naturally
  // drops the missing ones — but since we don't pass top_n by default,
  // every input gets a score).
  const seen = new Set<number>();
  const scoreByIndex = new Map<number, number>();
  const reorderedHead: SearchResult[] = [];
  for (const r of reranked) {
    if (r.index >= 0 && r.index < head.length && !seen.has(r.index)) {
      seen.add(r.index);
      if (Number.isFinite(r.relevanceScore)) scoreByIndex.set(r.index, r.relevanceScore);
      const item = head[r.index]!;
      // Stamp the reranker score onto the result so downstream callers
      // (telemetry, debug, autocut) can see the new ordering signal. Doesn't
      // replace `score` — that's RRF and other consumers may depend on it.
      item.rerank_score = r.relevanceScore;
      // v0.40.4 attribution stamp (D12=A) — rank delta. Positive means
      // rank improved (moved closer to top). new_index is the next
      // push position in reorderedHead; original index was r.index.
      item.reranker_delta = r.index - reorderedHead.length;
      reorderedHead.push(item);
    }
  }
  // If the reranker dropped some head items (rare; usually only happens
  // with explicit top_n), preserve their original positions at the end
  // of the head section so we don't silently lose recall.
  for (let i = 0; i < head.length; i++) {
    if (!seen.has(i)) reorderedHead.push(head[i]!);
  }

  const combined = [...reorderedHead, ...tail];
  const originalIndex = new Map(head.map((result, index) => [result, index]));
  const output = reorderedHead.map((result, index) => {
    const sourceIndex = originalIndex.get(result);
    return outputEvidence(
      result,
      index + 1,
      sourceIndex === undefined ? undefined : scoreByIndex.get(sourceIndex),
    );
  });
  report({
    status: 'succeeded',
    input_count: inputEvidence.length,
    output_count: output.length,
    input: inputEvidence,
    output,
    duration_ms: Math.max(0, Date.now() - callStartedAt),
    model_responded: modelResponded ?? null,
    fail_open: false,
  });
  return opts.topNOut !== null && opts.topNOut > 0
    ? combined.slice(0, opts.topNOut)
    : combined;
}
