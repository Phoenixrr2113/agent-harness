import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { discoverEnvKeys, parseEnvFile } from '../src/runtime/env-discovery.js';

describe('env-discovery', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'env-discover-test-'));
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('parseEnvFile', () => {
    it('should parse basic key=value pairs', () => {
      const result = parseEnvFile('API_KEY=sk-1234\nSECRET=mysecret');
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ name: 'API_KEY', hasValue: true });
      expect(result[1]).toEqual({ name: 'SECRET', hasValue: true });
    });

    it('should skip comments and empty lines', () => {
      const result = parseEnvFile('# Comment\n\nAPI_KEY=value\n# Another comment');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('API_KEY');
    });

    it('should detect empty/placeholder values', () => {
      const result = parseEnvFile([
        'EMPTY_KEY=',
        'PLACEHOLDER=your-key-here',
        'CHANGE_ME_KEY=CHANGE_ME',
        'VAR_REF=${OTHER_VAR}',
        'REAL_KEY=actual-value-123',
      ].join('\n'));

      const empty = result.filter((r) => !r.hasValue);
      const real = result.filter((r) => r.hasValue);
      expect(empty).toHaveLength(4);
      expect(real).toHaveLength(1);
      expect(real[0].name).toBe('REAL_KEY');
    });

    it('should handle quoted values', () => {
      const result = parseEnvFile('KEY="value with spaces"\nKEY2=\'single quoted\'');
      expect(result).toHaveLength(2);
      expect(result[0].hasValue).toBe(true);
      expect(result[1].hasValue).toBe(true);
    });

    it('should handle equals in value', () => {
      const result = parseEnvFile('DATABASE_URL=postgres://user:pass@host/db?sslmode=require');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('DATABASE_URL');
      expect(result[0].hasValue).toBe(true);
    });
  });

  describe('discoverEnvKeys', () => {
    it('should return empty when no .env files exist', () => {
      const result = discoverEnvKeys({ dir: testDir });
      expect(result.keys).toHaveLength(0);
      expect(result.filesScanned).toHaveLength(0);
      expect(result.suggestions).toHaveLength(0);
    });

    it('should detect known API keys from .env', () => {
      writeFileSync(join(testDir, '.env'), [
        'GITHUB_TOKEN=ghp_1234567890',
        'OPENAI_API_KEY=sk-proj-abc123',
        'RANDOM_VAR=foo',
      ].join('\n'));

      const result = discoverEnvKeys({ dir: testDir });
      expect(result.filesScanned).toHaveLength(1);
      expect(result.keys.length).toBeGreaterThanOrEqual(2);

      const keyNames = result.keys.map((k) => k.name);
      expect(keyNames).toContain('GITHUB_TOKEN');
      expect(keyNames).toContain('OPENAI_API_KEY');
      // RANDOM_VAR should NOT be included (doesn't match any pattern)
      expect(keyNames).not.toContain('RANDOM_VAR');
    });

    it('should generate suggestions for known services', () => {
      writeFileSync(join(testDir, '.env'), [
        'GITHUB_TOKEN=ghp_1234567890',
        'SLACK_TOKEN=xoxb-123',
        'NOTION_API_KEY=ntn_1234',
      ].join('\n'));

      const result = discoverEnvKeys({ dir: testDir });
      expect(result.suggestions.length).toBeGreaterThanOrEqual(3);

      const queries = result.suggestions.map((s) => s.serverQuery);
      expect(queries).toContain('github');
      expect(queries).toContain('slack');
      expect(queries).toContain('notion');
    });

    it('should scan multiple .env files', () => {
      writeFileSync(join(testDir, '.env'), 'GITHUB_TOKEN=gh_123');
      writeFileSync(join(testDir, '.env.local'), 'STRIPE_SECRET_KEY=sk_test_abc');

      const result = discoverEnvKeys({ dir: testDir });
      expect(result.filesScanned).toHaveLength(2);
      expect(result.keys.length).toBeGreaterThanOrEqual(2);
    });

    it('should deduplicate keys across files', () => {
      writeFileSync(join(testDir, '.env'), 'GITHUB_TOKEN=gh_123');
      writeFileSync(join(testDir, '.env.local'), 'GITHUB_TOKEN=gh_456');

      const result = discoverEnvKeys({ dir: testDir });
      const ghTokens = result.keys.filter((k) => k.name === 'GITHUB_TOKEN');
      expect(ghTokens).toHaveLength(1);
    });

    it('should detect generic API key patterns', () => {
      writeFileSync(join(testDir, '.env'), [
        'CUSTOM_SERVICE_API_KEY=abc123',
        'MY_AUTH_TOKEN=tok_xyz',
        'SOME_SECRET_KEY=sec_abc',
      ].join('\n'));

      const result = discoverEnvKeys({ dir: testDir });
      expect(result.keys.length).toBeGreaterThanOrEqual(3);
    });

    it('should scan extra directories', () => {
      const extraDir = mkdtempSync(join(tmpdir(), 'env-extra-'));
      writeFileSync(join(extraDir, '.env'), 'OPENAI_API_KEY=sk-test');

      const result = discoverEnvKeys({ dir: testDir, extraDirs: [extraDir] });
      expect(result.keys.some((k) => k.name === 'OPENAI_API_KEY')).toBe(true);

      rmSync(extraDir, { recursive: true, force: true });
    });

    it('should mark keys without values', () => {
      writeFileSync(join(testDir, '.env'), [
        'GITHUB_TOKEN=',
        'OPENAI_API_KEY=sk-real-key',
      ].join('\n'));

      const result = discoverEnvKeys({ dir: testDir });
      const gh = result.keys.find((k) => k.name === 'GITHUB_TOKEN');
      const openai = result.keys.find((k) => k.name === 'OPENAI_API_KEY');
      expect(gh?.hasValue).toBe(false);
      expect(openai?.hasValue).toBe(true);
    });
  });
});
