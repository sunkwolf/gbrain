/**
 * F2 measurement patch — per-call receipt.
 *
 * The load-bearing test here is the NEGATIVE CONTROL of the sink: when the sink
 * throws, the caller must be completely unaffected. A receipt is evidence, not
 * a dependency — losing it may degrade a run to "unverifiable", but it must
 * never change what the engine returns.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { withEnv } from '../helpers/with-env.ts';
import {
  emitCallReceipt,
  receiptsEnabled,
  newCallId,
  rerankerDigest,
  sharedKnobsDigest,
  canonicalSharedDigestMaterial,
  SHARED_DIGEST_VERSION,
  adaptiveReturnDigest,
  type CallReceipt,
} from '../../src/core/search/call-receipt.ts';
import { resolveSearchMode } from '../../src/core/search/mode.ts';

const ENV_KEY = 'GBRAIN_CALL_RECEIPT_PATH';
const created: string[] = [];

/**
 * F2 (2/2h) — the sink env var goes through `withEnv`, the repo's canonical
 * helper, instead of a raw `process.env` mutation.
 *
 * The 10th audit caught this as a BLOCKER and it was mine: `process.env` is
 * process-global, the parallel runner loads many files into one process per
 * shard, and this file was mutating it while NOT being `*.serial.test.ts`.
 * `check:test-isolation` failed on rule R1 — and I never saw it because I ran
 * the targeted tests and `tsc`, never `bun run verify`. A gate that exists in
 * the repo and that I did not run is not a gate that passed.
 *
 * `withEnv` (not renaming to `.serial`) on purpose: renaming would have made
 * the lint quiet by quarantining the file, while `withEnv` actually restores
 * the prior value via try/finally — including when the body throws. The
 * quarantine hides the leak; the helper removes it.
 */
async function withSink<T>(fn: (path: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-receipt-'));
  created.push(dir);
  const p = join(dir, 'receipts.jsonl');
  return withEnv({ [ENV_KEY]: p }, () => fn(p));
}

function receipt(over: Partial<CallReceipt> = {}): CallReceipt {
  return {
    receipt_version: '1.3',
    call_id: newCallId(),
    ts_utc: new Date(0).toISOString(),
    query: 'consulta congelada',
    latency_ms: 12,
    reranker_execution: {
      status: 'not_reached_cache_hit',
      input_count: 0,
      output_count: 0,
      input: [],
      output: [],
      duration_ms: null,
      model_responded: null,
      fail_open: false,
    },
    resolutions: [
      {
        stage: 'outer',
        knobs_hash: 'H_ON',
        cache_enabled: true,
        config_read: 'ok',
        skip_reasons: [],
        lookup_attempted: true,
        lookup_outcome: 'hit',
      },
    ],
    ...over,
  };
}

afterEach(() => {
  // No env cleanup here: `withEnv` restores every key it touched via
  // try/finally, so deleting it again would be a second source of truth for
  // the same invariant.
  for (const d of created.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe('call receipt', () => {
  test('OFF BY DEFAULT — no env var, no sink, no work', async () => {
    await withEnv({ [ENV_KEY]: undefined }, () => {
      expect(receiptsEnabled()).toBe(false);
      // Must not throw even with nowhere to write.
      expect(() => emitCallReceipt(receipt())).not.toThrow();
    });
  });

  test('POSITIVE CONTROL — with the sink set, the receipt lands and round-trips', async () => {
    await withSink(async (p) => {
      expect(receiptsEnabled()).toBe(true);

      const r = receipt();
      emitCallReceipt(r);

      expect(existsSync(p)).toBe(true);
      const lines = readFileSync(p, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(1);

      const back = JSON.parse(lines[0]) as CallReceipt;
      expect(back.call_id).toBe(r.call_id);
      expect(back.resolutions[0].knobs_hash).toBe('H_ON');
      expect(back.resolutions[0].cache_enabled).toBe(true);
    });
  });

  test('appends — one line per call, never overwrites prior evidence', async () => {
    await withSink(async (p) => {
      emitCallReceipt(receipt({ query: 'una' }));
      emitCallReceipt(receipt({ query: 'dos' }));
      const lines = readFileSync(p, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).query).toBe('una');
      expect(JSON.parse(lines[1]).query).toBe('dos');
    });
  });

  test('🔴 NEGATIVE CONTROL — a broken sink must not reach the caller', async () => {
    // Point the sink at a path that cannot be written (a directory component
    // that does not exist). appendFileSync will throw internally.
    await withEnv({ [ENV_KEY]: '/nonexistent-dir-gbrain-f2/receipts.jsonl' }, () => {
      expect(receiptsEnabled()).toBe(true);
      // The whole promise of the patch rests on this line.
      expect(() => emitCallReceipt(receipt())).not.toThrow();
    });
  });

  test('a hit carries outer only — inner absent is a state, not a gap', async () => {
    await withSink(async (p) => {
      emitCallReceipt(receipt()); // outer only, lookup_outcome: 'hit'
      const back = JSON.parse(readFileSync(p, 'utf-8').trim()) as CallReceipt;
      expect(back.resolutions).toHaveLength(1);
      expect(back.resolutions[0].stage).toBe('outer');
      expect(back.resolutions[0].lookup_outcome).toBe('hit');
      // The harness reads this as "the hit short-circuited before the inner
      // resolution", NOT as "the inner resolution reported nothing".
    });
  });

  test('a miss carries outer AND inner', async () => {
    await withSink(async (p) => {
      emitCallReceipt(receipt({
        resolutions: [
          {
            stage: 'outer', knobs_hash: 'H_OFF', cache_enabled: false, config_read: 'ok',
            skip_reasons: ['cache_disabled'], lookup_attempted: false,
            lookup_outcome: 'not_attempted',
          },
          {
            stage: 'inner', knobs_hash: 'H_OFF', cache_enabled: false, config_read: 'ok',
            skip_reasons: [], lookup_attempted: false,
          },
        ],
      }));
      const back = JSON.parse(readFileSync(p, 'utf-8').trim()) as CallReceipt;
      expect(back.resolutions.map(r => r.stage)).toEqual(['outer', 'inner']);
    });
  });

  test('config_read distinguishes an honest default from a silent fallback', async () => {
    await withSink(async (p) => {
      emitCallReceipt(receipt({
        resolutions: [{
          stage: 'outer', knobs_hash: 'H?', cache_enabled: true,
          config_read: 'fallback', // the read failed and defaults kicked in
          skip_reasons: [], lookup_attempted: true, lookup_outcome: 'miss',
        }],
      }));
      const back = JSON.parse(readFileSync(p, 'utf-8').trim()) as CallReceipt;
      // Without this field, "cache_enabled: true" is ambiguous between "the
      // operator wants it on" and "we could not read the config and defaulted".
      expect(back.resolutions[0].config_read).toBe('fallback');
    });
  });

  test('call ids are unique — resolutions of one call must not merge with another', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newCallId()));
    expect(ids.size).toBe(50);
  });
});

/**
 * F2 (2/2e) — the shared-hash digest, tested where its ALGEBRA can be tested.
 *
 * These properties belong here rather than in the wiring test, and the reason is
 * a lesson from the eighth audit: the wiring test can only vary what a
 * `hybridSearchCached` call can vary. Column dimensions and type are DB-plane
 * registry state — a live call cannot make two stages disagree on them, so an
 * implementation that dropped `dim` from the digest would pass every wiring
 * assertion. A gate whose components are not individually provable is a gate
 * that can quietly lose one, which is precisely how blocker 1 happened.
 */
describe('sharedKnobsDigest — the comparable hash for rule 6', () => {
  const knobs = resolveSearchMode({ mode: 'balanced' });
  const context = {
    embeddingColumn: 'embedding',
    embeddingModel: 'openai:text-embedding-3-small',
    hardExcludes: ['archive/', 'private/'],
  };
  const complete = {
    columnDimensions: 1536,
    columnType: 'vector',
    adaptiveReturn: 'off',
    rerankerEffective: 'src=bundle,en=0,m=none,in=8,out=none,t=2000,fn=0',
  };
  const digest = (
    resolved = knobs,
    ctx = context,
    extra: typeof complete = complete,
  ) => sharedKnobsDigest(resolved, ctx, extra)?.shared_knobs_hash;

  test('every component moves the hash — none is decorative', () => {
    const base = digest();
    expect(base).toBeDefined();
    expect(base).toMatch(/^[0-9a-f]{64}$/);

    // Each of these is state that changes what the engine actually did. If any
    // one of them stops moving the hash, two non-equivalent runs compare equal.
    const extraVariants: Array<[string, typeof complete]> = [
      ['column dimensions', { ...complete, columnDimensions: 1024 }],
      ['column type', { ...complete, columnType: 'halfvec' }],
      ['adaptive return: the switch', { ...complete, adaptiveReturn: 'on:3/10/1' }],
      // 🔴 The tenth audit's blocker, pinned: with the gate ON, each CAP must
      // move the hash on its own. Codex froze the inner's three caps to 1 —
      // a different effective policy — and the wiring file stayed green,
      // because only `enabled` was folded in.
      ['adaptive return: entityMax', { ...complete, adaptiveReturn: 'on:1/10/1' }],
      ['adaptive return: otherMax', { ...complete, adaptiveReturn: 'on:3/1/1' }],
      ['adaptive return: minKeep', { ...complete, adaptiveReturn: 'on:3/10/2' }],
      ['the effective reranker', { ...complete, rerankerEffective: 'src=per_call,en=1' }],
    ];
    for (const [what, extra] of extraVariants) {
      expect(digest(knobs, context, extra), `${what} must move the hash`).not.toBe(base);
    }
    expect(digest({ ...knobs, searchLimit: knobs.searchLimit + 1 }), 'a base knob must move the hash').not.toBe(base);
    expect(digest(knobs, { ...context, embeddingColumn: 'embedding_voyage' }), 'context must move the hash').not.toBe(base);
  });

  test('identical inputs give an identical hash — the gate has to be able to say "equal"', () => {
    expect(digest()).toBe(digest({ ...knobs }, { ...context }, { ...complete }));
  });

  test('HSH-002 exposes the complete typed preimage and its canonical bytes', () => {
    const evidence = sharedKnobsDigest(knobs, context, complete)!;
    expect(evidence.shared_digest_version).toBe(SHARED_DIGEST_VERSION);
    expect(evidence.shared_digest_material.components[0]).toEqual({
      name: 'knobs_hash_version', type: 'integer', value: 12,
    });
    expect(evidence.shared_digest_material.components.at(-1)).toEqual({
      name: 'reranker_effective', type: 'string', value: complete.rerankerEffective,
    });
    expect(canonicalSharedDigestMaterial(
      evidence.shared_digest_version,
      evidence.shared_digest_material,
    )).toStartWith('{"shared_digest_version":1,"components":[');
    // Cross-language golden HSH-002. The Python oracle pins the same material
    // and digest, so a TS/Python canonicalization split cannot stay green.
    expect(evidence.shared_knobs_hash).toBe(
      'bd97598e8afbbb5f76f13f78d8f635df119d53eaadf9c79864f9edfa3f17da1e',
    );
  });

  test('🔴 NEGATIVE CONTROL — an unknown component yields ABSENT, never a hash', () => {
    // The whole point. Hashing a missing value as a literal placeholder would
    // make two stages that BOTH failed to resolve it come out "equivalent" — a
    // gate reporting equality it never established. Absence is unverifiable and
    // the harness must treat it as invalidating.
    expect(sharedKnobsDigest(undefined, context, complete)).toBeUndefined();
    expect(sharedKnobsDigest(knobs, context, { ...complete, columnDimensions: undefined })).toBeUndefined();
    expect(sharedKnobsDigest(knobs, context, { ...complete, columnType: undefined })).toBeUndefined();
    expect(sharedKnobsDigest(knobs, context, { ...complete, adaptiveReturn: undefined })).toBeUndefined();
    expect(sharedKnobsDigest(knobs, context, { ...complete, rerankerEffective: undefined })).toBeUndefined();
  });
});

describe('adaptiveReturnDigest — the policy, not just the switch', () => {
  const on = { enabled: true, entityMax: 3, otherMax: 10, minKeep: 1 };

  test('🔴 each cap moves the digest when the gate is ON', () => {
    // The tenth audit's blocker in its smallest form. `resolveAdaptiveReturn`
    // resolves four values and the three caps decide how many results survive
    // the trim, so a digest carrying only `enabled` calls two different
    // policies equivalent.
    const base = adaptiveReturnDigest(on);
    expect(adaptiveReturnDigest({ ...on, entityMax: 1 })).not.toBe(base);
    expect(adaptiveReturnDigest({ ...on, otherMax: 1 })).not.toBe(base);
    expect(adaptiveReturnDigest({ ...on, minKeep: 2 })).not.toBe(base);
    expect(adaptiveReturnDigest({ ...on, enabled: false })).not.toBe(base);
  });

  test('the caps do NOT move it when the gate is OFF — and that is deliberate', () => {
    // The opposite error costs just as much. `applyAdaptiveReturn` returns
    // before reading the caps when disabled, so two gate-off stages with
    // different caps really did the same thing. Folding the caps anyway would
    // invalidate runs over a difference that changed nothing — a gate that
    // cries wolf gets ignored, and then it protects nothing.
    const off = { enabled: false, entityMax: 3, otherMax: 10, minKeep: 1 };
    expect(adaptiveReturnDigest({ ...off, entityMax: 99, otherMax: 99, minKeep: 99 }))
      .toBe(adaptiveReturnDigest(off));
    expect(adaptiveReturnDigest(off)).toBe('off');
  });
});

describe('rerankerDigest — what the pipeline would actually apply', () => {
  const bundle = {
    reranker_enabled: true,
    reranker_model: 'bundle-model',
    reranker_top_n_in: 8,
    reranker_top_n_out: 4,
    reranker_timeout_ms: 2000,
  };

  test('no per-call override reports the bundle', () => {
    const d = rerankerDigest(undefined, bundle);
    expect(d).toContain('src=bundle');
    expect(d).toContain('m=bundle-model');
    expect(d).toContain('en=1');
  });

  test('a per-call override replaces the bundle WHOLE — partials keep their gaps', () => {
    // This mirrors the pipeline exactly: `opts.reranker ?? bundle` takes the
    // object as given, it does not merge field by field. A digest that filled
    // the gaps from the bundle would describe a config the engine never used.
    const d = rerankerDigest({ enabled: true, topNIn: 3 }, bundle);
    expect(d).toContain('src=per_call');
    expect(d).toContain('in=3');
    expect(d).toContain('m=none'); // NOT 'bundle-model'
    expect(d).toContain('out=none');
    expect(d).toContain('t=none');
  });

  test('an explicit null cap is not the same state as an unset one', () => {
    const explicitNull = rerankerDigest({ enabled: true, topNIn: 3, topNOut: null }, bundle);
    const unset = rerankerDigest({ enabled: true, topNIn: 3 }, bundle);
    expect(explicitNull).toContain('out=null');
    expect(unset).toContain('out=none');
    expect(explicitNull).not.toBe(unset);
  });

  test('an injected reranker function is effective state, and shows', () => {
    // A run scored by a caller-supplied function is not comparable to one scored
    // by the real cross-encoder, however identical the other fields look.
    const withFn = rerankerDigest({ enabled: true, topNIn: 3, rerankerFn: async () => [] }, bundle);
    const withoutFn = rerankerDigest({ enabled: true, topNIn: 3 }, bundle);
    expect(withFn).toContain('fn=1');
    expect(withoutFn).toContain('fn=0');
    expect(withFn).not.toBe(withoutFn);
  });
});
