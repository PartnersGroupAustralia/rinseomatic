import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectBrand } from '../pure-utils.js';

describe('detectBrand', () => {
  describe('Visa', () => {
    it('detects 4-prefix as Visa', () => {
      assert.equal(detectBrand('4111111111111111').name, 'Visa');
    });

    it('Visa icon is correct', () => {
      assert.equal(detectBrand('4111111111111111').icon, '💳');
    });
  });

  describe('Mastercard (5-series)', () => {
    it('detects 51–55 prefix as Mastercard', () => {
      assert.equal(detectBrand('5111111111111111').name, 'Mastercard');
      assert.equal(detectBrand('5211111111111111').name, 'Mastercard');
      assert.equal(detectBrand('5311111111111111').name, 'Mastercard');
      assert.equal(detectBrand('5411111111111111').name, 'Mastercard');
      assert.equal(detectBrand('5511111111111111').name, 'Mastercard');
    });

    it('does not treat 56-prefix as Mastercard', () => {
      assert.notEqual(detectBrand('5611111111111111').name, 'Mastercard');
    });
  });

  describe('Mastercard (2-series)', () => {
    it('detects 22–27 prefix as Mastercard', () => {
      assert.equal(detectBrand('2221111111111111').name, 'Mastercard');
      assert.equal(detectBrand('2500000000000000').name, 'Mastercard');
      assert.equal(detectBrand('2720000000000000').name, 'Mastercard');
    });

    it('does not treat 20-prefix as Mastercard', () => {
      assert.notEqual(detectBrand('2011111111111111').name, 'Mastercard');
    });

    it('does not treat 28-prefix as Mastercard', () => {
      assert.notEqual(detectBrand('2811111111111111').name, 'Mastercard');
    });

    it('Mastercard icon is correct', () => {
      assert.equal(detectBrand('5123456789012346').icon, '🟠');
    });
  });

  describe('Amex', () => {
    it('detects 34-prefix as Amex', () => {
      assert.equal(detectBrand('341111111111111').name, 'Amex');
    });

    it('detects 37-prefix as Amex', () => {
      assert.equal(detectBrand('371111111111111').name, 'Amex');
    });

    it('Amex icon is correct', () => {
      assert.equal(detectBrand('371111111111111').icon, '🟦');
    });
  });

  describe('Discover', () => {
    it('detects 6-prefix as Discover', () => {
      assert.equal(detectBrand('6011111111111117').name, 'Discover');
    });

    it('Discover icon is correct', () => {
      assert.equal(detectBrand('6011111111111117').icon, '🔶');
    });
  });

  describe('unknown', () => {
    it('returns generic Card for unrecognised prefix', () => {
      assert.equal(detectBrand('9999999999999999').name, 'Card');
    });

    it('strips non-digit characters before matching', () => {
      assert.equal(detectBrand('4111-1111-1111-1111').name, 'Visa');
    });
  });
});
