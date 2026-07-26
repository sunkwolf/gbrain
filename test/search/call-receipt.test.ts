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
import {
  emitCallReceipt,
  receiptsEnabled,
  newCallId,
  type CallReceipt,
} from '../../src/core/search/call-receipt.ts';

const ENV_KEY = 'GBRAIN_CALL_RECEIPT_PATH';
const created: string[] = [];

function withSink(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-receipt-'));
  created.push(dir);
  const p = join(dir, 'receipts.jsonl');
  process.env[ENV_KEY] = p;
  return p;
}

function receipt(over: Partial<CallReceipt> = {}): CallReceipt {
  return {
    call_id: newCallId(),
    ts_utc: new Date(0).toISOString(),
    query: 'consulta congelada',
    latency_ms: 12,
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
  delete process.env[ENV_KEY];
  for (const d of created.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe('call receipt', () => {
  test('OFF BY DEFAULT — no env var, no sink, no work', () => {
    delete process.env[ENV_KEY];
    expect(receiptsEnabled()).toBe(false);
    // Must not throw even with nowhere to write.
    expect(() => emitCallReceipt(receipt())).not.toThrow();
  });

  test('POSITIVE CONTROL — with the sink set, the receipt lands and round-trips', () => {
    const p = withSink();
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

  test('appends — one line per call, never overwrites prior evidence', () => {
    const p = withSink();
    emitCallReceipt(receipt({ query: 'una' }));
    emitCallReceipt(receipt({ query: 'dos' }));
    const lines = readFileSync(p, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).query).toBe('una');
    expect(JSON.parse(lines[1]).query).toBe('dos');
  });

  test('🔴 NEGATIVE CONTROL — a broken sink must not reach the caller', () => {
    // Point the sink at a path that cannot be written (a directory component
    // that does not exist). appendFileSync will throw internally.
    process.env[ENV_KEY] = '/nonexistent-dir-gbrain-f2/receipts.jsonl';
    expect(receiptsEnabled()).toBe(true);
    // The whole promise of the patch rests on this line.
    expect(() => emitCallReceipt(receipt())).not.toThrow();
  });

  test('a hit carries outer only — inner absent is a state, not a gap', () => {
    const p = withSink();
    emitCallReceipt(receipt()); // outer only, lookup_outcome: 'hit'
    const back = JSON.parse(readFileSync(p, 'utf-8').trim()) as CallReceipt;
    expect(back.resolutions).toHaveLength(1);
    expect(back.resolutions[0].stage).toBe('outer');
    expect(back.resolutions[0].lookup_outcome).toBe('hit');
    // The harness reads this as "the hit short-circuited before the inner
    // resolution", NOT as "the inner resolution reported nothing".
  });

  test('a miss carries outer AND inner', () => {
    const p = withSink();
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

  test('config_read distinguishes an honest default from a silent fallback', () => {
    const p = withSink();
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

  test('call ids are unique — resolutions of one call must not merge with another', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newCallId()));
    expect(ids.size).toBe(50);
  });
});
