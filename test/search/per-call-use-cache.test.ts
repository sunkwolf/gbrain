/**
 * F2 measurement patch — per-call `use_cache` gate.
 *
 * Asymmetric on purpose. `false` only ever forces MORE work (a fresh search),
 * so any caller may ask for it — and it is the one direction the measurement
 * harness needs. `true` re-enables the cache "even when global config has it
 * off" (SearchOpts.useCache, types.ts), which overrides an operator decision,
 * so it is local-only — same gate as per-call mode.
 *
 * Declaring this parameter is therefore NOT a purely observational change, and
 * these tests are what keeps that claim honest.
 */

import { describe, test, expect } from 'bun:test';
import { resolvePerCallUseCache, resolvePerCallMode } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/operations.ts';

function ctx(remote: boolean | undefined): OperationContext {
  return { remote } as unknown as OperationContext;
}

describe('resolvePerCallUseCache', () => {
  // --- the safe direction: opting OUT of the cache ---

  test('POSITIVE CONTROL — local caller can force a fresh search', () => {
    expect(resolvePerCallUseCache(ctx(false), false)).toBe(false);
  });

  test('remote caller can ALSO force a fresh search (false is never harmful)', () => {
    expect(resolvePerCallUseCache(ctx(true), false)).toBe(false);
    expect(resolvePerCallUseCache(ctx(undefined), false)).toBe(false);
  });

  // --- the dangerous direction: opting back IN ---

  test('local caller may re-enable the cache for one call', () => {
    expect(resolvePerCallUseCache(ctx(false), true)).toBe(true);
  });

  test('NEGATIVE CONTROL — remote caller CANNOT re-enable the cache', () => {
    // This is the whole point of the gate: without it, a remote caller could
    // undo an operator's global `search.cache.enabled = false`.
    expect(resolvePerCallUseCache(ctx(true), true)).toBeUndefined();
  });

  test('NEGATIVE CONTROL — remote===undefined is treated as remote', () => {
    // Same conservative reading as resolvePerCallMode: only an explicit
    // `remote === false` counts as local.
    expect(resolvePerCallUseCache(ctx(undefined), true)).toBeUndefined();
  });

  // --- absence and junk ---

  test('omitted → undefined (follow configured default)', () => {
    expect(resolvePerCallUseCache(ctx(false), undefined)).toBeUndefined();
  });

  test('non-boolean is ignored, not coerced', () => {
    // 'true' as a string must not sneak past the gate as a truthy value.
    expect(resolvePerCallUseCache(ctx(true), 'true')).toBeUndefined();
    expect(resolvePerCallUseCache(ctx(true), 1)).toBeUndefined();
    expect(resolvePerCallUseCache(ctx(false), 'false')).toBeUndefined();
    expect(resolvePerCallUseCache(ctx(false), null)).toBeUndefined();
  });

  // --- the gate must bite in the same direction as the existing one ---

  test('mirrors the per-call mode gate for the privileged direction', () => {
    // If these two ever disagree about what "remote" means, one of them is wrong.
    expect(resolvePerCallMode(ctx(true), 'tokenmax')).toBeUndefined();
    expect(resolvePerCallUseCache(ctx(true), true)).toBeUndefined();
  });
});
