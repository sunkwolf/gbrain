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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

    // What would invalidate this control: the three runs taking different
    // paths. If one of them served from the cache, the comparison would be
    // between a fresh result and a JSONB roundtrip — different serialization
    // for identical data, i.e. a failure that says nothing about the patch.
    // Assert the shared path explicitly instead of assuming it.
    expect(off.cacheStatus).toBe('miss');
    expect(on.cacheStatus).toBe('miss');
    expect(broken.cacheStatus).toBe('miss');

    expect(off.threw).toBeNull();
    expect(on.threw).toBeNull();
    // The load-bearing assertion: a broken instrument does not break the call.
    expect(broken.threw).toBeNull();

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
