import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getLoginUrl, JOE_LOGIN_URL, IGNITION_LOGIN_URL } from '../run-config.js';

describe('getLoginUrl', () => {
  it("returns Joe Fortune URL for 'joe'", () => {
    assert.equal(getLoginUrl('joe'), JOE_LOGIN_URL);
  });

  it("returns Ignition URL for 'ign'", () => {
    assert.equal(getLoginUrl('ign'), IGNITION_LOGIN_URL);
  });

  it("returns Ignition URL for 'ignition'", () => {
    assert.equal(getLoginUrl('ignition'), IGNITION_LOGIN_URL);
  });

  it('falls back to Joe Fortune URL for unknown site string', () => {
    assert.equal(getLoginUrl('unknown-site'), JOE_LOGIN_URL);
  });

  it('falls back to Joe Fortune URL for null input', () => {
    assert.equal(getLoginUrl(null), JOE_LOGIN_URL);
  });

  it('falls back to Joe Fortune URL for undefined input', () => {
    assert.equal(getLoginUrl(undefined), JOE_LOGIN_URL);
  });

  it('falls back to Joe Fortune URL for empty string', () => {
    assert.equal(getLoginUrl(''), JOE_LOGIN_URL);
  });

  it('JOE_LOGIN_URL is a valid https URL', () => {
    assert.ok(JOE_LOGIN_URL.startsWith('https://'));
  });

  it('IGNITION_LOGIN_URL is a valid https URL', () => {
    assert.ok(IGNITION_LOGIN_URL.startsWith('https://'));
  });
});
