import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCardLine } from '../pure-utils.js';

describe('parseCardLine', () => {
  describe('valid pipe-separated cards', () => {
    it('parses a 16-digit pipe-separated card', () => {
      const c = parseCardLine('5123456789012346|08|26|123');
      assert.ok(c, 'should not be null');
      assert.equal(c.number, '5123456789012346');
      assert.equal(c.mm, '08');
      assert.equal(c.yy, '26');
      assert.equal(c.cvv, '123');
      assert.equal(c.brand, 'Mastercard');
      assert.equal(c.status, 'untested');
    });

    it('parses a Visa card', () => {
      const c = parseCardLine('4111111111111111|01|28|456');
      assert.ok(c);
      assert.equal(c.brand, 'Visa');
      assert.equal(c.number, '4111111111111111');
    });

    it('parses a 4-year expiry by taking last 2 digits', () => {
      const c = parseCardLine('4111111111111111|12|2027|999');
      assert.ok(c);
      assert.equal(c.yy, '27');
    });

    it('parses a 13-digit card (minimum valid length)', () => {
      const c = parseCardLine('4000000000001|06|25|123');
      assert.ok(c);
      assert.equal(c.number, '4000000000001');
    });

    it('parses a 19-digit card (maximum valid length)', () => {
      const c = parseCardLine('4000000000000000001|06|25|123');
      assert.ok(c);
      assert.equal(c.number.length, 19);
    });
  });

  describe('valid space-separated cards', () => {
    it('parses space-separated card', () => {
      const c = parseCardLine('5123456789012346 08 26 123');
      assert.ok(c);
      assert.equal(c.number, '5123456789012346');
    });
  });

  describe('valid slash-separated cards', () => {
    it('parses slash-separated card', () => {
      const c = parseCardLine('5123456789012346/08/26/123');
      assert.ok(c);
      assert.equal(c.number, '5123456789012346');
    });
  });

  describe('leading and trailing whitespace', () => {
    it('trims surrounding whitespace', () => {
      const c = parseCardLine('  5123456789012346|08|26|123  ');
      assert.ok(c);
      assert.equal(c.number, '5123456789012346');
    });
  });

  describe('invalid cards', () => {
    it('returns null for empty string', () => {
      assert.equal(parseCardLine(''), null);
    });

    it('returns null for whitespace-only string', () => {
      assert.equal(parseCardLine('   '), null);
    });

    it('returns null for too-few parts', () => {
      assert.equal(parseCardLine('5123456789012346|08|26'), null);
    });

    it('returns null for a 12-digit card number (too short)', () => {
      assert.equal(parseCardLine('512345678901|08|26|123'), null);
    });

    it('returns null for a 20-digit card number (too long)', () => {
      assert.equal(parseCardLine('51234567890123456789|08|26|123'), null);
    });

    it('returns null for non-numeric card number (BUG-21)', () => {
      assert.equal(parseCardLine('ABCDE12345678901|01|25|123'), null);
    });

    it('returns null for alphanumeric card number', () => {
      assert.equal(parseCardLine('4111ABC111111111|01|25|123'), null);
    });

    it('returns null for missing CVV', () => {
      assert.equal(parseCardLine('5123456789012346|08|26|'), null);
    });
  });

  describe('object shape', () => {
    it('includes all required fields', () => {
      const c = parseCardLine('5123456789012346|08|26|123');
      assert.ok(typeof c.id === 'string');
      assert.ok(typeof c.number === 'string');
      assert.ok(typeof c.mm === 'string');
      assert.ok(typeof c.yy === 'string');
      assert.ok(typeof c.cvv === 'string');
      assert.ok(typeof c.brand === 'string');
      assert.ok(typeof c.brandIcon === 'string');
      assert.equal(c.successCount, 0);
      assert.equal(c.totalTests, 0);
      assert.equal(c.lastTested, null);
      assert.deepEqual(c.testHistory, []);
      assert.ok(typeof c.addedAt === 'number');
    });
  });
});
