import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { maskedNumber } from '../pure-utils.js';

describe('maskedNumber', () => {
  it('returns the number as-is for 8-digit cards (too short to mask)', () => {
    assert.equal(maskedNumber('12345678'), '12345678');
  });

  it('returns the number as-is for 9-digit cards (BUG-14 edge case)', () => {
    assert.equal(maskedNumber('123456789'), '123456789');
  });

  it('returns the number as-is for 1-digit input', () => {
    assert.equal(maskedNumber('4'), '4');
  });

  it('masks a 13-digit card correctly', () => {
    const result = maskedNumber('4000000000001');
    assert.equal(result, '400000•••0001');
    assert.equal(result.length, 13);
  });

  it('masks a 16-digit card correctly', () => {
    const result = maskedNumber('4111111111111111');
    assert.equal(result, '411111••••••1111');
    assert.equal(result.length, 16);
  });

  it('masks a 19-digit card correctly', () => {
    const result = maskedNumber('4000000000000000001');
    assert.equal(result, '400000•••••••••0001');
    assert.equal(result.length, 19);
  });

  it('always shows first 6 and last 4 digits for long numbers', () => {
    const num = '5123456789012346';
    const result = maskedNumber(num);
    assert.ok(result.startsWith(num.slice(0, 6)));
    assert.ok(result.endsWith(num.slice(-4)));
  });

  it('never produces negative bullet counts (no RangeError)', () => {
    assert.doesNotThrow(() => maskedNumber('1234567890'));
  });
});
