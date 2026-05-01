import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAutomationUrl, nextBackoffMs } from '../../server-utils.js';

describe('normalizeAutomationUrl', () => {
  it('adds https protocol for scheme-less external hosts', () => {
    const out = normalizeAutomationUrl('example.com/login');
    assert.equal(out, 'https://example.com/login');
  });

  it('uses http for localhost hosts when scheme is missing', () => {
    const out = normalizeAutomationUrl('localhost:3000/login');
    assert.equal(out, 'http://localhost:3000/login');
  });

  it('preserves valid http/https URLs', () => {
    assert.equal(normalizeAutomationUrl('http://example.com/a'), 'http://example.com/a');
    assert.equal(normalizeAutomationUrl('https://example.com/a'), 'https://example.com/a');
  });

  it('rejects unsupported URL protocols', () => {
    assert.throws(
      () => normalizeAutomationUrl('javascript:alert(1)'),
      /URL is not valid|URL protocol must be http or https/i
    );
    assert.throws(
      () => normalizeAutomationUrl('ftp://example.com/file'),
      /URL protocol must be http or https/i
    );
  });

  it('rejects empty values', () => {
    assert.throws(() => normalizeAutomationUrl(''), /non-empty string/i);
    assert.throws(() => normalizeAutomationUrl('   '), /non-empty string/i);
  });
});

describe('nextBackoffMs', () => {
  it('returns base delay for non-positive or invalid current values', () => {
    assert.equal(nextBackoffMs(0), 2000);
    assert.equal(nextBackoffMs(-1), 2000);
    assert.equal(nextBackoffMs(NaN), 2000);
  });

  it('doubles current delay with a max cap', () => {
    assert.equal(nextBackoffMs(2000), 4000);
    assert.equal(nextBackoffMs(4000), 8000);
    assert.equal(nextBackoffMs(60000), 60000);
    assert.equal(nextBackoffMs(120000), 60000);
  });

  it('honors custom base and max values', () => {
    assert.equal(nextBackoffMs(0, 500, 2000), 500);
    assert.equal(nextBackoffMs(500, 500, 2000), 1000);
    assert.equal(nextBackoffMs(1500, 500, 2000), 2000);
  });
});
