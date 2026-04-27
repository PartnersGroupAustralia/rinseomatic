import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCredLine } from '../pure-utils.js';

describe('parseCredLine', () => {
  describe('colon separator', () => {
    it('parses user:pass format', () => {
      const c = parseCredLine('user@example.com:password123');
      assert.ok(c);
      assert.equal(c.username, 'user@example.com');
      assert.equal(c.password, 'password123');
    });

    it('handles password containing colons', () => {
      const c = parseCredLine('user@example.com:p:a:s:s');
      assert.ok(c);
      assert.equal(c.username, 'user@example.com');
      assert.equal(c.password, 'p:a:s:s');
    });
  });

  describe('pipe separator', () => {
    it('parses user|pass format', () => {
      const c = parseCredLine('user@example.com|password123');
      assert.ok(c);
      assert.equal(c.username, 'user@example.com');
      assert.equal(c.password, 'password123');
    });
  });

  describe('semicolon separator', () => {
    it('parses user;pass format', () => {
      const c = parseCredLine('user@example.com;password123');
      assert.ok(c);
      assert.equal(c.username, 'user@example.com');
      assert.equal(c.password, 'password123');
    });
  });

  describe('comma separator', () => {
    it('parses user,pass format', () => {
      const c = parseCredLine('user@example.com,password123');
      assert.ok(c);
      assert.equal(c.username, 'user@example.com');
      assert.equal(c.password, 'password123');
    });
  });

  describe('tab separator', () => {
    it('parses user\\tpass format', () => {
      const c = parseCredLine('user@example.com\tpassword123');
      assert.ok(c);
      assert.equal(c.username, 'user@example.com');
      assert.equal(c.password, 'password123');
    });
  });

  describe('space separator (BUG-01 fix)', () => {
    it('parses space-separated credentials', () => {
      const c = parseCredLine('user@email.com password123');
      assert.ok(c, 'space-separated credentials must not return null');
      assert.equal(c.username, 'user@email.com');
      assert.equal(c.password, 'password123');
    });

    it('handles multiple spaces as separator', () => {
      const c = parseCredLine('user@email.com  password123');
      assert.ok(c);
      assert.equal(c.username, 'user@email.com');
      assert.equal(c.password, 'password123');
    });
  });

  describe('comment and empty lines', () => {
    it('returns null for comment lines starting with #', () => {
      assert.equal(parseCredLine('# this is a comment'), null);
    });

    it('returns null for empty string', () => {
      assert.equal(parseCredLine(''), null);
    });

    it('returns null for whitespace-only string', () => {
      assert.equal(parseCredLine('   '), null);
    });
  });

  describe('short username rejection', () => {
    it('returns null when username is fewer than 3 characters', () => {
      assert.equal(parseCredLine('ab:password123'), null);
    });

    it('accepts username of exactly 3 characters', () => {
      const c = parseCredLine('abc:password123');
      assert.ok(c);
      assert.equal(c.username, 'abc');
    });
  });

  describe('short password rejection', () => {
    it('returns null when password is empty after separator', () => {
      assert.equal(parseCredLine('user@example.com:'), null);
    });
  });

  describe('no separator', () => {
    it('returns null for a line with no recognised separator', () => {
      assert.equal(parseCredLine('justaplainword'), null);
    });
  });

  describe('object shape', () => {
    it('includes all required fields with correct types', () => {
      const c = parseCredLine('user@example.com:password123');
      assert.ok(typeof c.id === 'string');
      assert.equal(c.username, 'user@example.com');
      assert.equal(c.password, 'password123');
      assert.equal(c.status, 'untested');
      assert.ok(typeof c.addedAt === 'number');
      assert.deepEqual(c.testHistory, []);
    });
  });
});
