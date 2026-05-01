import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hashUnit, seededDelay, loginOutcomeFromSeed, ppsrOutcomeFromSeed, CredStatus } from '../pure-utils.js';

describe('hashUnit', () => {
  it('returns a number in [0, 1)', () => {
    const r = hashUnit('test-seed');
    assert.ok(r >= 0 && r < 1, `expected [0,1), got ${r}`);
  });

  it('is deterministic for the same seed', () => {
    assert.equal(hashUnit('abc'), hashUnit('abc'));
  });

  it('produces different values for different seeds', () => {
    assert.notEqual(hashUnit('seed-a'), hashUnit('seed-b'));
  });

  it('handles empty string without throwing', () => {
    assert.doesNotThrow(() => hashUnit(''));
    const r = hashUnit('');
    assert.ok(r >= 0 && r < 1);
  });

  it('handles long strings', () => {
    const long = 'x'.repeat(10000);
    const r = hashUnit(long);
    assert.ok(r >= 0 && r < 1);
  });
});

describe('seededDelay', () => {
  it('returns a value within [minMs, maxMs]', () => {
    const d = seededDelay('test', 500, 2000);
    assert.ok(d >= 500 && d <= 2000, `expected 500–2000, got ${d}`);
  });

  it('is deterministic for the same seed and range', () => {
    assert.equal(seededDelay('s', 100, 500), seededDelay('s', 100, 500));
  });

  it('returns minMs when minMs equals maxMs', () => {
    assert.equal(seededDelay('any', 750, 750), 750);
  });

  it('handles inverted range (maxMs < minMs) gracefully — returns minMs', () => {
    const d = seededDelay('any', 1000, 500);
    assert.equal(d, 1000);
  });
});

describe('loginOutcomeFromSeed', () => {
  const VALID_STATUSES = new Set([
    CredStatus.WORKING,
    CredStatus.NO_ACC,
    CredStatus.PERM_DISABLED,
    CredStatus.TEMP_DISABLED,
  ]);

  it('returns a valid status for joe site', () => {
    const o = loginOutcomeFromSeed('joe|url|user|pass', 'joe');
    assert.ok(VALID_STATUSES.has(o.status), `unexpected status: ${o.status}`);
  });

  it('returns a valid status for ign site', () => {
    const o = loginOutcomeFromSeed('ign|url|user|pass', 'ign');
    assert.ok(VALID_STATUSES.has(o.status));
  });

  it('is deterministic for the same seed', () => {
    const a = loginOutcomeFromSeed('seed1', 'joe');
    const b = loginOutcomeFromSeed('seed1', 'joe');
    assert.equal(a.status, b.status);
    assert.equal(a.detail, b.detail);
  });

  it('includes Joe Fortune in the detail for joe siteId when working', () => {
    const seeds = Array.from({ length: 500 }, (_, i) => `joe-${i}`);
    const working = seeds.map(s => loginOutcomeFromSeed(s, 'joe')).find(o => o.status === CredStatus.WORKING);
    assert.ok(working, 'expected at least one WORKING result across 500 seeds');
    assert.ok(working.detail.includes('Joe Fortune'));
  });

  it('includes Ignition in the detail for ign siteId when working', () => {
    const seeds = Array.from({ length: 500 }, (_, i) => `ign-${i}`);
    const working = seeds.map(s => loginOutcomeFromSeed(s, 'ign')).find(o => o.status === CredStatus.WORKING);
    assert.ok(working, 'expected at least one WORKING result across 500 seeds');
    assert.ok(working.detail.includes('Ignition'));
  });

  it('produces ~30% WORKING outcomes across many seeds', () => {
    const seeds = Array.from({ length: 1000 }, (_, i) => `dist-test-${i}`);
    const outcomes = seeds.map(s => loginOutcomeFromSeed(s, 'joe'));
    const workingCount = outcomes.filter(o => o.status === CredStatus.WORKING).length;
    assert.ok(workingCount > 200 && workingCount < 400, `expected ~300 working, got ${workingCount}`);
  });

  it('produces ~50% NO_ACC outcomes across many seeds', () => {
    const seeds = Array.from({ length: 1000 }, (_, i) => `dist-test-${i}`);
    const outcomes = seeds.map(s => loginOutcomeFromSeed(s, 'joe'));
    const noAccCount = outcomes.filter(o => o.status === CredStatus.NO_ACC).length;
    assert.ok(noAccCount > 400 && noAccCount < 600, `expected ~500 no-acc, got ${noAccCount}`);
  });
});

describe('ppsrOutcomeFromSeed', () => {
  const VALID_RESULTS = new Set(['working', 'dead', 'error']);

  it('returns a valid result value', () => {
    const o = ppsrOutcomeFromSeed('card|mm|yy|cvv');
    assert.ok(VALID_RESULTS.has(o.result), `unexpected result: ${o.result}`);
  });

  it('is deterministic for the same seed', () => {
    const a = ppsrOutcomeFromSeed('same-seed');
    const b = ppsrOutcomeFromSeed('same-seed');
    assert.equal(a.result, b.result);
    assert.equal(a.detail, b.detail);
  });

  it('includes a non-empty detail string', () => {
    const o = ppsrOutcomeFromSeed('some-seed');
    assert.ok(typeof o.detail === 'string' && o.detail.length > 0);
  });

  it('produces ~35% working outcomes across many seeds', () => {
    const seeds = Array.from({ length: 1000 }, (_, i) => `ppsr-dist-${i}`);
    const outcomes = seeds.map(s => ppsrOutcomeFromSeed(s));
    const workingCount = outcomes.filter(o => o.result === 'working').length;
    assert.ok(workingCount > 250 && workingCount < 450, `expected ~350 working, got ${workingCount}`);
  });

  it('produces ~50% dead outcomes across many seeds', () => {
    const seeds = Array.from({ length: 1000 }, (_, i) => `ppsr-dist-${i}`);
    const outcomes = seeds.map(s => ppsrOutcomeFromSeed(s));
    const deadCount = outcomes.filter(o => o.result === 'dead').length;
    assert.ok(deadCount > 400 && deadCount < 600, `expected ~500 dead, got ${deadCount}`);
  });
});
