import { describe, test, expect } from 'bun:test';
import { resolveSearchMode, knobsHashParts, KNOBS_HASH_VERSION } from '../../src/core/search/mode.ts';
import { knobsHashCoverageGaps, coverageGapsForParts } from '../../src/core/search/call-receipt.ts';

/**
 * The guard that stops the shared digest from silently ignoring a knob that
 * upstream added to `knobsHash`.
 *
 * It is tested in BOTH directions on purpose, and the second direction is the
 * one nobody runs: a guard that only ever proves it CAN fire is
 * indistinguishable from one that fires always, and a guard that cries wolf
 * gets switched off in people's heads long before it gets switched off in
 * code.
 *
 * The "must not bite" fixture is not invented — it is the real shape of
 * upstream 85286a55 (KNOBS_HASH_VERSION 13 → 14, the compiled_truth boost
 * scope): one line changed, zero components added. A version-based guard
 * would have demanded a digest bump and a fixture recapture for nothing.
 */
describe('knobs-hash coverage guard — the shared digest cannot silently drop a knob', () => {
  const knobs = resolveSearchMode({ mode: 'balanced' } as never);

  test('the real knobsHashParts today has NO uncovered prefix', () => {
    expect(knobsHashCoverageGaps(knobs as never, undefined)).toEqual([]);
  });

  test('the guard actually looks at every prefix — not at a hardcoded count', () => {
    // If it enumerated its own list instead of reading knobsHashParts, this
    // number could drift the same way the digest did. Reading it here means a
    // shrinking parts list is visible too, not just a growing one.
    const prefixes = knobsHashParts(knobs as never, undefined)
      .map((p) => (p.indexOf('=') === -1 ? p : p.slice(0, p.indexOf('='))));
    expect(prefixes.length).toBeGreaterThan(30);
    expect(new Set(prefixes).size).toBe(prefixes.length); // no duplicate keys
  });

  test('🔴 MUTANT — it BITES, through the REAL predicate', () => {
    // The fabricated part goes INTO the actual function. An earlier version of
    // this test rebuilt the prefix list by hand and asserted on its own
    // arithmetic — it would have passed with the guard deleted. That is a sign,
    // not a lock.
    const real = knobsHashParts(knobs as never, undefined);
    expect(coverageGapsForParts([...real, 'brandnewknob=1'])).toEqual(['brandnewknob']);
    // Two at once, so it reports the SET and not just the first one it meets.
    expect(coverageGapsForParts([...real, 'aaa=1', 'zzz=2'])).toEqual(['aaa', 'zzz']);
  });

  test('🔴 CONTROL — the same predicate stays silent on the real list', () => {
    // Without this, "it bites" is indistinguishable from "it bites at
    // everything". Same function, same call shape, unmutated input.
    expect(coverageGapsForParts(knobsHashParts(knobs as never, undefined))).toEqual([]);
  });

  test('🔴 MUTANT THAT MUST NOT BITE — a behaviour-only bump (the real v13→v14)', () => {
    // upstream 85286a55 bumped KNOBS_HASH_VERSION and added NO component. The
    // parts list is unchanged in shape, so coverage must stay silent. This is
    // the direction a version-based guard fails, and the reason this guard
    // discriminates by COMPONENT instead.
    const before = knobsHashParts(knobs as never, undefined)
      .map((p) => p.slice(0, p.indexOf('=')));
    // The only thing such a bump changes is the VALUE of `v=`.
    const afterBehaviourOnlyBump = knobsHashParts(knobs as never, undefined)
      .map((p) => (p.startsWith('v=') ? `v=${KNOBS_HASH_VERSION + 1}` : p))
      .map((p) => p.slice(0, p.indexOf('=')));
    expect(afterBehaviourOnlyBump).toEqual(before);
    expect(knobsHashCoverageGaps(knobs as never, undefined)).toEqual([]);
  });

  test('`fts` — the knob that actually drifted — is covered now', () => {
    const prefixes = knobsHashParts(knobs as never, undefined)
      .map((p) => p.slice(0, p.indexOf('=')));
    expect(prefixes).toContain('fts');
    expect(knobsHashCoverageGaps(knobs as never, undefined)).not.toContain('fts');
  });
});
