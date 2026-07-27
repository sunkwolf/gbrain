/**
 * F2 measurement patch (2/2b) — the receipt WIRED into the real search.
 *
 * The module test (call-receipt.test.ts) proves the sink behaves. This one
 * proves the thing that actually matters for the harness: that a real query,
 * against a real brain, emits ONE receipt whose contents match the path the
 * engine actually took — and that turning the instrument on (or breaking it)
 * changes NOTHING about what the caller gets back.
 *
 * The load-bearing test here is the equivalence control. Everything else
 * describes the instrument; that one is what lets us say the instrument is
 * safe to run inside a measurement whose results we intend to trust.
 *
 * What is claimed, and what is not:
 *   - results + order + meta : IDENTICAL with receipts off, on, and broken.
 *   - wall time              : NOT claimed. Writing a receipt costs time.
 *
 * Drives the REAL pipeline (PGLite brain, real SemanticQueryCache
 * store→lookup roundtrip, mocked `embedQuery` for a deterministic vector),
 * following test/search-telemetry-cache-wiring.serial.test.ts.
 *
 * Serial: mock.module + gateway/global-env mutation (isolation guard R2).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realEmbedding from '../../src/core/embedding.ts';
import type { CallReceipt } from '../../src/core/search/call-receipt.ts';

/** Deterministic 1536d unit vector — identical for every call, so the same
 * query's second consult matches its first write at cosine 1.0. */
function fixedEmbedding(): Float32Array {
  const arr = new Float32Array(1536);
  for (let i = 0; i < 1536; i++) arr[i] = Math.sin(1 + i * 0.001);
  let norm = 0;
  for (let i = 0; i < 1536; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < 1536; i++) arr[i] /= norm;
  return arr;
}

let embedBehavior: (() => Promise<Float32Array>) | null = null;

mock.module('../../src/core/embedding.ts', () => ({
  ...realEmbedding,
  embed: async () => (embedBehavior ? embedBehavior() : fixedEmbedding()),
  embedQuery: async () => (embedBehavior ? embedBehavior() : fixedEmbedding()),
}));

// Import AFTER mocking.
const { hybridSearch, hybridSearchCached, awaitPendingSearchCacheWrites, _resetPendingSearchCacheWritesForTests } =
  await import('../../src/core/search/hybrid.ts');
const { configureGateway, resetGateway } = await import('../../src/core/ai/gateway.ts');
const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');

let engine: InstanceType<typeof PGLiteEngine>;
let tmpHome: string;
let sinkDir: string;
let sinkPath: string;
const savedGbrainHome = process.env.GBRAIN_HOME;
const savedReceiptPath = process.env.GBRAIN_CALL_RECEIPT_PATH;

/** Read every receipt written so far. Absent file = no receipts. */
function readReceipts(path = sinkPath): CallReceipt[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as CallReceipt);
}

function resolutionOf(r: CallReceipt, stage: 'outer' | 'inner') {
  return r.resolutions.find((x) => x.stage === stage);
}

/**
 * Start every case from an empty cache so a run is a fresh-path miss.
 *
 * The `await` on pending writes is load-bearing, and this test file learned it
 * the hard way: the writeback is fire-and-forget, so a DELETE issued while one
 * is in flight lets the row land AFTERWARDS. The next run then silently takes
 * the HIT path — and a hit returns rows rehydrated from JSONB, whose KEY ORDER
 * differs from a freshly built object (Postgres orders jsonb keys by length,
 * then bytewise). Identical values, different serialization: a byte-for-byte
 * comparison fails while nothing is actually wrong.
 */
async function clearCache(): Promise<void> {
  await awaitPendingSearchCacheWrites();
  _resetPendingSearchCacheWritesForTests();
  await engine.executeRaw('DELETE FROM query_cache');
}

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-receipt-wiring-'));
  process.env.GBRAIN_HOME = tmpHome;
  sinkDir = mkdtempSync(join(tmpdir(), 'gbrain-receipt-sink-'));
  sinkPath = join(sinkDir, 'receipts.jsonl');

  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-fake' },
  });

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  await engine.putPage('alice-foo', {
    type: 'person',
    title: 'Alice Foo',
    compiled_truth: 'Alice Foo is a builder who ships search receipt fixtures.',
  });
  await engine.upsertChunks('alice-foo', [
    { chunk_index: 0, chunk_text: 'Alice Foo is a builder who ships search receipt fixtures.', chunk_source: 'compiled_truth' },
  ]);
  await engine.putPage('bob-bar', {
    type: 'person',
    title: 'Bob Bar',
    compiled_truth: 'Bob Bar is a builder who reviews cache receipt fixtures.',
  });
  await engine.upsertChunks('bob-bar', [
    { chunk_index: 0, chunk_text: 'Bob Bar is a builder who reviews cache receipt fixtures.', chunk_source: 'compiled_truth' },
  ]);
});

afterAll(async () => {
  if (savedGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = savedGbrainHome;
  if (savedReceiptPath === undefined) delete process.env.GBRAIN_CALL_RECEIPT_PATH;
  else process.env.GBRAIN_CALL_RECEIPT_PATH = savedReceiptPath;
  try { await engine.disconnect(); } catch { /* ignore */ }
  resetGateway();
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(sinkDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(async () => {
  embedBehavior = null;
  rmSync(sinkPath, { force: true });
  process.env.GBRAIN_CALL_RECEIPT_PATH = sinkPath;
  await clearCache();
});

afterEach(() => {
  delete process.env.GBRAIN_CALL_RECEIPT_PATH;
});

describe('call receipt — wired into hybridSearchCached', () => {
  test('fresh call: exactly one receipt, outer AND inner, writeback attempted', async () => {
    const results = await hybridSearchCached(engine, 'alice receipt fixtures', { limit: 5 });
    expect(results.length).toBeGreaterThan(0);

    const receipts = readReceipts();
    // Cardinality: one call, one receipt. Two lines sharing a call_id would
    // make a LOST line indistinguishable from a resolution that never ran.
    expect(receipts.length).toBe(1);
    const r = receipts[0];
    expect(r.call_id.length).toBeGreaterThan(0);
    expect(r.query).toBe('alice receipt fixtures');
    expect(r.call_outcome).toBe('fresh');
    expect(typeof r.latency_ms).toBe('number');
    // This fixture's resolved bundle enables a reranker, but the hermetic
    // gateway intentionally has no reranker credential. The search still
    // returns results; the receipt must call that what it is: a failed
    // attempt followed by fail-open, never a healthy/disabled stage.
    expect(r.reranker_execution.status).toBe('failed');
    expect(r.reranker_execution.fail_open).toBe(true);
    if (r.reranker_execution.status === 'failed') {
      expect(r.reranker_execution.failure_reason).toBe('auth');
      expect(r.reranker_execution.input.map((x) => x.slug)).toEqual(
        r.reranker_execution.output.map((x) => x.slug),
      );
    }

    const outer = resolutionOf(r, 'outer');
    const inner = resolutionOf(r, 'inner');
    expect(outer).toBeDefined();
    // 'fresh' + no inner is the ANOMALY state; this asserts we don't emit it
    // on the ordinary path.
    expect(inner).toBeDefined();

    expect(outer!.cache_enabled).toBe(true);
    expect(outer!.skip_reasons).toEqual([]);
    expect(outer!.lookup_attempted).toBe(true);
    expect(outer!.lookup_outcome).toBe('miss');
    expect(outer!.lookup_blocked_by).toBeUndefined();
    expect(outer!.knobs_hash!.length).toBeGreaterThan(0);
    expect(outer!.config_read).toBe('ok');
    expect(outer!.config_read_failures).toBeUndefined();
    expect(outer!.search_limit).toBe(5);

    // Both resolutions read the same knobs. A mismatch here is the exact
    // failure the two-resolution receipt exists to expose.
    expect(inner!.knobs_hash).toBe(outer!.knobs_hash);
    expect(inner!.cache_enabled).toBe(outer!.cache_enabled);

    expect(r.writeback?.attempted).toBe(true);
    expect(r.writeback?.blocked_by).toBeUndefined();

    // Control that the writeback the receipt CLAIMS actually landed.
    await awaitPendingSearchCacheWrites();
    const rows = await engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM query_cache');
    expect(rows[0].n).toBe(1);
  });

  test('cache hit: one receipt, outer only, and the absence is declared as a hit', async () => {
    await hybridSearchCached(engine, 'alice receipt fixtures', { limit: 5 });
    await awaitPendingSearchCacheWrites();
    rmSync(sinkPath, { force: true });

    let meta: import('../../src/core/types.ts').HybridSearchMeta | undefined;
    const second = await hybridSearchCached(engine, 'alice receipt fixtures', {
      limit: 5,
      onMeta: (m) => { meta = m; },
    });
    expect(meta?.cache?.status).toBe('hit');
    expect(second.length).toBeGreaterThan(0);

    const receipts = readReceipts();
    expect(receipts.length).toBe(1);
    const r = receipts[0];
    expect(r.call_outcome).toBe('hit');
    expect(r.reranker_execution.status).toBe('not_reached_cache_hit');
    expect(resolutionOf(r, 'outer')!.lookup_outcome).toBe('hit');
    expect(resolutionOf(r, 'outer')!.lookup_attempted).toBe(true);
    // The whole point of the optional inner: a hit returns BEFORE the inner
    // search exists. Absent + 'hit' is expected; absent + 'fresh' is not.
    expect(resolutionOf(r, 'inner')).toBeUndefined();
    // A hit performs no writeback, and the receipt says which guard stopped it.
    expect(r.writeback?.attempted).toBeUndefined();
  });

  test('use_cache:false — skip reason is named, not just "disabled"', async () => {
    const results = await hybridSearchCached(engine, 'bob receipt fixtures', { limit: 5, useCache: false });
    expect(results.length).toBeGreaterThan(0);

    const r = readReceipts()[0];
    const outer = resolutionOf(r, 'outer')!;
    expect(outer.cache_enabled).toBe(false);
    // Pre-patch, all five skip reasons collapsed into one boolean. This is the
    // distinction the harness needs: the operator turned it off, as opposed to
    // a non-default column or adaptive return silently skipping the cache.
    expect(outer.skip_reasons).toEqual(['cache_disabled']);
    expect(outer.lookup_attempted).toBe(false);
    expect(outer.lookup_blocked_by).toBe('skip_cache');
    expect(r.writeback?.attempted).toBe(false);
    expect(r.writeback?.blocked_by).toContain('cache_status_disabled');
    // The fresh path still ran, so the inner resolution must be there.
    expect(resolutionOf(r, 'inner')).toBeDefined();
  });

  test('skip reasons come from the SAME list the decision does — no second source of truth', async () => {
    // The reason list and `skipCache` are derived from one array in the
    // wrapper, so they cannot drift. This pins the observable half of that:
    // whenever a reason is reported, the cache really was not consulted — and
    // the reason NAMES the cause instead of collapsing to "disabled".
    const cases: Array<{ opts: Record<string, unknown>; reason: string }> = [
      { opts: { walkDepth: 1 }, reason: 'walk_depth' },
      { opts: { nearSymbol: 'Alice' }, reason: 'near_symbol' },
      { opts: { useCache: false }, reason: 'cache_disabled' },
    ];
    for (const c of cases) {
      rmSync(sinkPath, { force: true });
      await clearCache();
      await hybridSearchCached(engine, 'alice receipt fixtures', { limit: 5, ...c.opts });
      const outer = resolutionOf(readReceipts()[0], 'outer')!;
      expect(outer.skip_reasons).toContain(c.reason);
      expect(outer.lookup_attempted).toBe(false);
      expect(outer.lookup_blocked_by).toBe('skip_cache');
    }

    // Control that the assertion above can fail: the SAME query with none of
    // those options reports no reason and DOES consult the cache. Without
    // this, `skip_reasons` could contain every name always and pass.
    rmSync(sinkPath, { force: true });
    await clearCache();
    await hybridSearchCached(engine, 'alice receipt fixtures', { limit: 5 });
    const clean = resolutionOf(readReceipts()[0], 'outer')!;
    expect(clean.skip_reasons).toEqual([]);
    expect(clean.lookup_attempted).toBe(true);
  });

  test('use_cache override: shared hash MATCHES across stages while the effective hashes legitimately differ', async () => {
    // This is the test the eighth audit said was missing, and its absence is
    // what let a broken invalidation rule survive.
    //
    // The outer folds per-call `use_cache` into its resolution; the inner does
    // NOT. So on any `use_cache` override the two EFFECTIVE hashes differ —
    // legitimately, every single time. A harness rule reading "hashes differ ⇒
    // invalid" would therefore discard exactly the condition the experiment
    // needs. `shared_knobs_hash` normalizes the cache decision out so the two
    // stages stay comparable on everything else, which is what that rule was
    // actually trying to ask.
    await hybridSearchCached(engine, 'alice receipt fixtures', { limit: 5, useCache: false });
    const r = readReceipts()[0];
    const outer = resolutionOf(r, 'outer')!;
    const inner = resolutionOf(r, 'inner')!;

    // The comparable half agrees...
    expect(outer.shared_knobs_hash).toBeDefined();
    expect(inner.shared_knobs_hash).toBe(outer.shared_knobs_hash!);
    // ...while the effective hashes differ, and that difference is EXPECTED.
    expect(outer.knobs_hash).not.toBe(inner.knobs_hash);
    expect(outer.cache_enabled).toBe(false);
    expect(inner.cache_enabled).toBe(true); // the inner never saw the override

    // 🔴 The ninth audit PROVED this test's control was a false green, and the
    // proof is worth more than the fix: Codex mutated the inner resolution to
    // force `searchLimit:5` no matter what the call asked for, and the test
    // still passed. The old control ran a second call with `limit:7` and then
    // inspected the OUTER only — so a shared hash that had stopped tracking the
    // inner entirely still looked healthy. A control that only ever re-reads one
    // side of a two-sided equality cannot detect the side it stopped reading.
    //
    // The variation loop below is the fix, and it is parametrized per shared
    // knob on purpose: one hard-coded knob only proves the hash is not a
    // constant, and each knob reaches the hash through a DIFFERENT path
    // (searchLimit through knobsHash, the reranker and adaptive-return through
    // the 2/2e digest that knobsHash omits). Each variation asserts BOTH
    // properties that make this hash a gate:
    //
    //   agreement : the two stages still resolve to the same shared hash;
    //   movement  : that hash differs from the baseline pair, so the knob is
    //               actually inside it and not silently dropped.
    //
    // Drop either half and the gate rots: without agreement the inner can
    // freeze (the mutant above); without movement the whole thing can collapse
    // to a constant and every comparison passes.
    const baseline = outer.shared_knobs_hash!;
    const variations: Array<{ name: string; opts: Record<string, unknown> }> = [
      // Reaches the hash through knobsHash (`lim=`).
      { name: 'limit', opts: { limit: 7 } },
      // Reaches it through `reranker_effective` — the field knobsHash omits.
      // `enabled:false` so nothing actually runs a reranker: the digest must
      // change because the RESOLUTION SOURCE changed (per-call, not bundle),
      // which is exactly the divergence the ninth audit named.
      {
        name: 'reranker',
        opts: { reranker: { enabled: false, topNIn: 3, topNOut: 2, model: 'stub-reranker', timeoutMs: 50 } },
      },
      // Reaches it through `adaptive_return`, which knobsHash does not carry at
      // all — each stage resolves it from its own config read.
      { name: 'adaptiveReturn', opts: { adaptiveReturn: true } },
    ];

    for (const v of variations) {
      rmSync(sinkPath, { force: true });
      await clearCache();
      await hybridSearchCached(engine, 'alice receipt fixtures', {
        limit: 5,
        useCache: false,
        ...v.opts,
      });
      const varied = readReceipts()[0];
      const vOuter = resolutionOf(varied, 'outer')!;
      const vInner = resolutionOf(varied, 'inner')!;

      // Absence is unverifiable, never agreement — assert presence explicitly
      // so a pair of `undefined`s can never satisfy the equality below.
      expect(vOuter.shared_knobs_hash, `${v.name}: outer hash present`).toBeDefined();
      expect(vInner.shared_knobs_hash, `${v.name}: inner hash present`).toBeDefined();
      // AGREEMENT — this is the assertion the mutant escaped.
      expect(vInner.shared_knobs_hash, `${v.name}: stages agree`).toBe(vOuter.shared_knobs_hash!);
      // MOVEMENT — both sides moved off the baseline, so the knob is in the hash.
      expect(vOuter.shared_knobs_hash, `${v.name}: outer moved`).not.toBe(baseline);
      expect(vInner.shared_knobs_hash, `${v.name}: inner moved`).not.toBe(baseline);
    }
  });

  test('the state knobsHash OMITS is carried per stage, not just folded into the hash', async () => {
    // Blocker 1 of the ninth audit had two halves. The hash closes the gate;
    // these fields make a closed gate diagnosable. Without them a stage
    // mismatch reports "the hashes differ" and the cause has to be bisected out
    // of the engine — which in practice means the observation gets discarded
    // with no cause recorded, and a systematic divergence reads as noise.
    await hybridSearchCached(engine, 'alice receipt fixtures', { limit: 5, useCache: false });
    const r = readReceipts()[0];
    const outer = resolutionOf(r, 'outer')!;
    const inner = resolutionOf(r, 'inner')!;

    for (const [stage, res] of [['outer', outer], ['inner', inner]] as const) {
      expect(res.column_dimensions, `${stage}: dimensions`).toBe(1536);
      expect(res.column_type, `${stage}: column type`).toBe('vector');
      expect(res.adaptive_return, `${stage}: adaptive return`).toBe(false);
      // Resolved from the mode bundle here — no per-call override in this call.
      expect(res.reranker_effective, `${stage}: reranker digest`).toContain('src=bundle');
      expect(res.reranker_effective, `${stage}: reranker fn absent`).toContain('fn=0');
    }
    // The geometry is what makes two same-NAMED columns different vector spaces,
    // so the two stages agreeing on it is the claim, not just reporting it.
    expect(inner.column_dimensions).toBe(outer.column_dimensions);
    expect(inner.column_type).toBe(outer.column_type);
    expect(inner.reranker_effective).toBe(outer.reranker_effective);
  });

  test('a per-call reranker override shows up as per_call in BOTH stages', async () => {
    // This is the divergence Codex found by reading: the inner applies
    // `opts.reranker` directly (hybrid.ts rerank step) while the outer hashed
    // the mode bundle's reranker. Same call, two different rerankers, and the
    // shared hash said "equivalent". Both stages must now report the per-call
    // resolution — including its partial-ness, since the pipeline takes the
    // override WHOLE rather than merging it field by field.
    rmSync(sinkPath, { force: true });
    await clearCache();
    await hybridSearchCached(engine, 'alice receipt fixtures', {
      limit: 5,
      useCache: false,
      reranker: { enabled: false, topNIn: 3, topNOut: null, model: 'stub-reranker', timeoutMs: 50 },
    });
    const r = readReceipts()[0];
    const outer = resolutionOf(r, 'outer')!;
    const inner = resolutionOf(r, 'inner')!;

    for (const [stage, res] of [['outer', outer], ['inner', inner]] as const) {
      expect(res.reranker_effective, `${stage}: source`).toContain('src=per_call');
      expect(res.reranker_effective, `${stage}: model`).toContain('m=stub-reranker');
      // `null` is an explicit "no output cap" and must not read as "unset".
      expect(res.reranker_effective, `${stage}: explicit null cap`).toContain('out=null');
    }
    expect(inner.reranker_effective).toBe(outer.reranker_effective);
    expect(inner.shared_knobs_hash).toBe(outer.shared_knobs_hash);
  });

  test('a lookup that THREW is reported as error, not as a healthy miss', async () => {
    // The cache turns every exception into `{hit:false}`. Pre-fix the receipt
    // copied that reading verbatim, so a control asserting "with the cache off
    // the sentinel is not served" would PASS on a run where the cache was on
    // and merely broken — the false green this instrument exists to prevent.
    const realExec = engine.executeRaw.bind(engine);
    (engine as unknown as { executeRaw: unknown }).executeRaw = async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('FROM query_cache')) {
        throw new Error('lookup exploded on purpose');
      }
      return realExec(sql, params as never);
    };
    try {
      const results = await hybridSearchCached(engine, 'alice receipt fixtures', { limit: 5 });
      // The search still serves — the swallow is correct behavior, and stays.
      expect(results.length).toBeGreaterThan(0);
    } finally {
      (engine as unknown as { executeRaw: unknown }).executeRaw = realExec;
    }

    const outer = resolutionOf(readReceipts()[0], 'outer')!;
    expect(outer.lookup_attempted).toBe(true);
    expect(outer.lookup_outcome).toBe('error');
    expect(outer.lookup_error).toContain('exploded on purpose');

    // NEGATIVE CONTROL: the same query with the lookup healthy reports a
    // plain miss and carries no error. Without this, `lookup_outcome` could be
    // hardwired to 'error' and the assertion above would still pass.
    rmSync(sinkPath, { force: true });
    await clearCache();
    await hybridSearchCached(engine, 'alice receipt fixtures', { limit: 5 });
    const clean = resolutionOf(readReceipts()[0], 'outer')!;
    expect(clean.lookup_outcome).toBe('miss');
    expect(clean.lookup_error).toBeUndefined();
  });

  test("two hits prove they came from the SAME row — D′ against D″, not one hit's id", async () => {
    // The ninth audit: the implementation was right, the test promised more than
    // it proved. It took ONE hit and checked the id existed in `query_cache` —
    // which cannot fail as long as some row is there — while the claim this field
    // exists to support is about TWO observations: that D″ was served by the same
    // row as D′ and not by a replacement written in between. One hit can never
    // establish that, however well the assertion is written.
    await hybridSearchCached(engine, 'alice receipt fixtures', { limit: 5 }); // seeds
    await awaitPendingSearchCacheWrites();
    rmSync(sinkPath, { force: true });

    // D′
    await hybridSearchCached(engine, 'alice receipt fixtures', { limit: 5 });
    await awaitPendingSearchCacheWrites();
    const dPrime = resolutionOf(readReceipts()[0], 'outer')!;
    expect(dPrime.lookup_outcome).toBe('hit');
    expect(dPrime.cache_row_id).toBeDefined();

    // The state of the table BETWEEN the two hits. A hit only bumps
    // `hit_count` — it never inserts — so a changed row set here means someone
    // else wrote, and the pair stops being a two-observation-of-one-row claim.
    const between = await engine.executeRaw<{ id: string }>('SELECT id FROM query_cache ORDER BY id');

    // D″
    rmSync(sinkPath, { force: true });
    await hybridSearchCached(engine, 'alice receipt fixtures', { limit: 5 });
    await awaitPendingSearchCacheWrites();
    const dDouble = resolutionOf(readReceipts()[0], 'outer')!;
    expect(dDouble.lookup_outcome).toBe('hit');
    expect(dDouble.cache_row_id).toBeDefined();

    // THE CLAIM: same row, both times.
    expect(dDouble.cache_row_id).toBe(dPrime.cache_row_id!);

    // NO INTERMEDIATE WRITE. Without this, an identical id across two hits is
    // still compatible with the row having been deleted and rewritten under the
    // same deterministic id — `query_cache.id` is
    // sha256("<source>::<query>::<hash>"), so a replacement REUSES the id. The
    // id proves identity of the key, not continuity of the row; the row set has
    // to be checked separately.
    const after = await engine.executeRaw<{ id: string }>('SELECT id FROM query_cache ORDER BY id');
    expect(after.map((r) => r.id)).toEqual(between.map((r) => r.id));

    // And it is a row that really is in the table, not a fabrication.
    expect(after.map((r) => r.id)).toContain(dDouble.cache_row_id!);
  });

  test('a throw BEFORE the inner search still emits exactly one receipt', async () => {
    // The 2b fence only wrapped the inner call, so an early throw produced
    // ZERO receipts with a healthy sink — indistinguishable from a lost one.
    let threw: string | null = null;
    try {
      await hybridSearchCached(engine, 'alice receipt fixtures', {
        limit: 5,
        // Unknown column: the resolver throws on purpose, well before the
        // inner search exists.
        embeddingColumn: 'no_such_embedding_column_at_all',
      });
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    // The error must still reach the caller, untouched.
    expect(threw).not.toBeNull();

    const receipts = readReceipts();
    expect(receipts.length).toBe(1);
    expect(receipts[0].call_outcome).toBe('error');
    expect(receipts[0].error).toBeDefined();
    // No inner resolution: it never got there. That is the honest reading.
    expect(resolutionOf(receipts[0], 'inner')).toBeUndefined();
  });

  test('embed failure: separated from "the cache was off"', async () => {
    embedBehavior = async () => { throw new Error('embed provider down'); };
    const results = await hybridSearchCached(engine, 'bob receipt fixtures', { limit: 5 });
    // The degraded run still serves via keyword — that is the behavior we are
    // measuring around, not changing.
    expect(results.length).toBeGreaterThan(0);

    const outer = resolutionOf(readReceipts()[0], 'outer')!;
    // Both this and the previous test produce zero lookups and a 'disabled'
    // cache status in meta. Only the receipt tells them apart.
    expect(outer.cache_enabled).toBe(true);
    expect(outer.skip_reasons).toEqual([]);
    expect(outer.lookup_attempted).toBe(false);
    expect(outer.lookup_blocked_by).toBe('embed_failed');
  });

  test('config_read: a swallowed key read shows as fallback, and names the key', async () => {
    const original = engine.getConfig.bind(engine);
    // The ghost this field exists for: `search.cache.enabled = false` whose
    // read throws falls through to the mode-bundle default (ON for all three
    // bundles). The run is cached while the operator believes it is not.
    (engine as unknown as { getConfig: (k: string) => Promise<string | null> }).getConfig = async (k: string) => {
      if (k === 'search.cache.enabled') throw new Error('config read exploded');
      return original(k);
    };
    try {
      const results = await hybridSearchCached(engine, 'alice receipt fixtures', { limit: 5 });
      expect(results.length).toBeGreaterThan(0);
    } finally {
      (engine as unknown as { getConfig: unknown }).getConfig = original;
    }

    const r = readReceipts()[0];
    for (const stage of ['outer', 'inner'] as const) {
      const res = resolutionOf(r, stage)!;
      expect(res.config_read).toBe('fallback');
      expect(res.config_read_failures).toContain('search.cache.enabled');
    }

    // NEGATIVE CONTROL for this assertion: with the read restored, the same
    // query reports 'ok'. Without this, `config_read` could be hardwired to
    // 'fallback' and the test above would still pass.
    rmSync(sinkPath, { force: true });
    await clearCache();
    await hybridSearchCached(engine, 'alice receipt fixtures', { limit: 5 });
    expect(resolutionOf(readReceipts()[0], 'outer')!.config_read).toBe('ok');
  });

  test('config_read also covers the DB-plane loader, whose failures never null the config', async () => {
    // The 8th audit's blocker 5. `loadConfigWithEngine` swallows per key AND
    // returns a usable base config anyway, so the null check the 2b receipt
    // relied on could never fire: it reported `ok` while the reads that decide
    // the embedding column and cache safety had been masked.
    //
    // `search_embedding_column` is NOT in the mode-config key list, so pre-fix
    // this failure was invisible to the receipt in every field it had.
    const original = engine.getConfig.bind(engine);
    (engine as unknown as { getConfig: (k: string) => Promise<string | null> }).getConfig = async (k: string) => {
      if (k === 'search_embedding_column') throw new Error('db-plane read exploded');
      return original(k);
    };
    try {
      const results = await hybridSearchCached(engine, 'alice receipt fixtures', { limit: 5 });
      expect(results.length).toBeGreaterThan(0);
    } finally {
      (engine as unknown as { getConfig: unknown }).getConfig = original;
    }

    const r = readReceipts()[0];
    for (const stage of ['outer', 'inner'] as const) {
      const res = resolutionOf(r, stage)!;
      expect(res.config_read).toBe('fallback');
      expect(res.config_read_failures).toContain('search_embedding_column (db-plane)');
    }

    // NEGATIVE CONTROL: restored, the same query reports 'ok'.
    rmSync(sinkPath, { force: true });
    await clearCache();
    await hybridSearchCached(engine, 'alice receipt fixtures', { limit: 5 });
    expect(resolutionOf(readReceipts()[0], 'outer')!.config_read).toBe('ok');
  });

  test('the FILE plane is a separate diagnosis, and an absent file is not a failure', async () => {
    // F2 (2/2f). This brain has no `~/.gbrain/config.json` (GBRAIN_HOME points at
    // a temp dir), which is the normal install state — so the receipt must report
    // it AND must not call it a fallback. Reporting it matters anyway: a harness
    // comparing lab against production needs to know the lab had no config file
    // where production has one.
    await hybridSearchCached(engine, 'alice receipt fixtures', { limit: 5 });
    const r = readReceipts()[0];
    for (const stage of ['outer', 'inner'] as const) {
      const res = resolutionOf(r, stage)!;
      expect(res.config_file_read, `${stage}: file plane reported`).toBe('absent');
      expect(res.config_file_error, `${stage}: no error for an absent file`).toBeUndefined();
      expect(res.config_read, `${stage}: absent is honest, not a fallback`).toBe('ok');
    }
  });

  test('🔴 a present-but-broken config file shows as a FILE-plane failure, while the DB plane says ok', async () => {
    // The ninth audit's open blocker, end to end. Before this, a malformed config
    // file and no config file at all were the same reading — and the malformed
    // one silently drops `embedding_model`, `embedding_dimensions`,
    // `embedding_columns` and `search_embedding_column`, then
    // `loadConfigWithEngine` synthesizes `{engine:'postgres'}` so the DB-plane
    // diagnostic reports `ok` because nothing failed on its side. Different
    // vector space, all instruments green.
    const cfgDir = join(tmpHome, '.gbrain');
    const cfgFile = join(cfgDir, 'config.json');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(cfgFile, '{ "engine": "postgres", "embedding_dimensions": ');
    try {
      const results = await hybridSearchCached(engine, 'alice receipt fixtures', { limit: 5 });
      // The search still works — that masking is correct for behavior. The point
      // is that it is no longer silent.
      expect(results.length).toBeGreaterThan(0);
    } finally {
      rmSync(cfgFile, { force: true });
    }

    const r = readReceipts()[0];
    for (const stage of ['outer', 'inner'] as const) {
      const res = resolutionOf(r, stage)!;
      expect(res.config_file_read, `${stage}: parse error named`).toBe('parse_error');
      expect(res.config_file_error, `${stage}: error carried`).toBeTruthy();
      // It folds into the one-bit summary too, so a harness reading only
      // `config_read` still invalidates the run.
      expect(res.config_read, `${stage}: rolls up to fallback`).toBe('fallback');
      expect(
        res.config_read_failures?.some((f) => f.startsWith('config_file (parse_error')),
        `${stage}: failure names the plane and the step`,
      ).toBe(true);
    }

    // NEGATIVE CONTROL: with the file gone the same query is back to `absent`
    // and `ok`. Without this, an implementation hardwired to 'parse_error' —
    // or one that left the previous call's diagnostic lying around — passes.
    rmSync(sinkPath, { force: true });
    await clearCache();
    await hybridSearchCached(engine, 'alice receipt fixtures', { limit: 5 });
    const after = resolutionOf(readReceipts()[0], 'outer')!;
    expect(after.config_file_read).toBe('absent');
    expect(after.config_read).toBe('ok');
  });

  test('bare hybridSearch emits nothing — no half receipt without an outer', async () => {
    const results = await hybridSearch(engine, 'alice receipt fixtures', { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    // An inner-only receipt would read as "the outer resolution vanished".
    expect(readReceipts()).toEqual([]);
  });

  test('receipts off: zero work, zero file', async () => {
    delete process.env.GBRAIN_CALL_RECEIPT_PATH;
    const results = await hybridSearchCached(engine, 'alice receipt fixtures', { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(existsSync(sinkPath)).toBe(false);
  });

  test('call_ids are unique per call', async () => {
    await hybridSearchCached(engine, 'alice receipt fixtures', { limit: 5 });
    await clearCache();
    await hybridSearchCached(engine, 'bob receipt fixtures', { limit: 5 });
    const ids = readReceipts().map((r) => r.call_id);
    expect(ids.length).toBe(2);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('EQUIVALENCE CONTROL — the instrument does not change the answer', () => {
  /**
   * Run the identical query from an identical starting state three ways and
   * compare what the caller receives, byte for byte:
   *
   *   1. receipts OFF                  — the production path
   *   2. receipts ON, healthy sink     — the lab path
   *   3. receipts ON, sink that THROWS — the lab path with the instrument
   *                                      broken (unwritable path)
   *
   * Case 3 is the one that matters. A sink that throws into the search would
   * turn a measurement run into an outage, and — worse — a partial failure
   * could reorder or truncate results while every dashboard stayed green.
   */
  async function runOnce(receiptPath: string | undefined): Promise<{
    results: string;
    meta: string;
    cacheStatus: string | undefined;
    threw: string | null;
  }> {
    await clearCache();
    if (receiptPath === undefined) delete process.env.GBRAIN_CALL_RECEIPT_PATH;
    else process.env.GBRAIN_CALL_RECEIPT_PATH = receiptPath;
    let meta: import('../../src/core/types.ts').HybridSearchMeta | null = null;
    try {
      const results = await hybridSearchCached(engine, 'builder receipt fixtures', {
        limit: 5,
        onMeta: (m) => { meta = m; },
      });
      return {
        results: JSON.stringify(results),
        meta: JSON.stringify(meta),
        cacheStatus: (meta as import('../../src/core/types.ts').HybridSearchMeta | null)?.cache?.status,
        threw: null,
      };
    } catch (e) {
      return {
        results: '',
        meta: JSON.stringify(meta),
        cacheStatus: undefined,
        threw: e instanceof Error ? e.message : String(e),
      };
    }
  }

  test('results, order and meta are identical with receipts off, on, and broken', async () => {
    const off = await runOnce(undefined);
    const on = await runOnce(sinkPath);
    // A path under a directory that does not exist: appendFileSync throws
    // ENOENT on every call.
    const brokenPath = join(sinkDir, 'no-such-dir', 'receipts.jsonl');
    const broken = await runOnce(brokenPath);

    // Order matters here, and a mutant proved it: with these after the
    // path-check below, a sink that rethrows fails on "cacheStatus is
    // undefined" — true, but it points at the wrong thing. The throw checks
    // come first so the mutation that breaks the swallow reports itself.
    expect(off.threw).toBeNull();
    expect(on.threw).toBeNull();
    // The load-bearing assertion: a broken instrument does not break the call.
    expect(broken.threw).toBeNull();

    // What would invalidate this control: the three runs taking different
    // paths. If one of them served from the cache, the comparison would be
    // between a fresh result and a JSONB roundtrip — different serialization
    // for identical data, i.e. a failure that says nothing about the patch.
    // Assert the shared path explicitly instead of assuming it.
    expect(off.cacheStatus).toBe('miss');
    expect(on.cacheStatus).toBe('miss');
    expect(broken.cacheStatus).toBe('miss');

    expect(off.results.length).toBeGreaterThan(2); // not comparing two empties
    expect(on.results).toBe(off.results);
    expect(broken.results).toBe(off.results);
    expect(on.meta).toBe(off.meta);
    expect(broken.meta).toBe(off.meta);

    // Positive control for the comparison itself: the healthy run really did
    // write a receipt, so case 2 exercised the emission path it claims to.
    expect(readReceipts().length).toBe(1);
    // And the broken run wrote nothing anywhere.
    expect(existsSync(brokenPath)).toBe(false);
  });
});
