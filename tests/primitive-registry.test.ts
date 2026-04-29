import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { scaffoldHarness } from '../src/cli/scaffold.js';
import {
  createManifest,
  writeManifest,
  readManifest,
  packBundle,
  writeBundleDir,
  readBundleDir,
  installBundle,
  uninstallBundle,
  diffBundle,
  updateBundle,
  readInstalledManifests,
  listInstalledBundles,
} from '../src/runtime/primitive-registry.js';
import type { BundleManifest, PackedBundle } from '../src/runtime/primitive-registry.js';

describe('primitive-registry', () => {
  let harnessDir: string;
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'prim-reg-test-'));
    harnessDir = join(tmpBase, 'test-agent');
    scaffoldHarness(harnessDir, 'test-agent');
  });

  afterEach(() => {
    if (existsSync(tmpBase)) {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  // Helper: create test primitives
  function createTestPrimitives(): void {
    writeFileSync(
      join(harnessDir, 'rules', 'code-style.md'),
      '---\nid: code-style\ntags: [coding]\n---\n# Code Style\n\nUse consistent formatting.',
    );
    writeFileSync(
      join(harnessDir, 'rules', 'testing.md'),
      '---\nid: testing\ntags: [testing]\n---\n# Testing Rules\n\nWrite tests for everything.',
    );
    writeFileSync(
      join(harnessDir, 'rules', 'be-concise.md'),
      '---\nid: be-concise\ntags: [communication]\n---\n# Be Concise\n\nKeep responses short.',
    );
  }

  describe('Manifest', () => {
    it('should create a manifest from files', () => {
      createTestPrimitives();
      const manifest = createManifest(harnessDir, {
        name: 'test-bundle',
        description: 'Test bundle',
        files: ['rules/code-style.md', 'rules/testing.md'],
        tags: ['coding'],
      });

      expect(manifest.name).toBe('test-bundle');
      expect(manifest.description).toBe('Test bundle');
      expect(manifest.version).toBe('1.0');
      expect(manifest.types).toContain('rules');
      expect(manifest.files).toHaveLength(2);
      expect(manifest.files[0].id).toBe('code-style');
      expect(manifest.tags).toEqual(['coding']);
    });

    it('should write and read a manifest', () => {
      createTestPrimitives();
      const manifest = createManifest(harnessDir, {
        name: 'roundtrip',
        description: 'Roundtrip test',
        files: ['rules/code-style.md'],
      });

      const manifestPath = join(tmpBase, 'manifest.yaml');
      writeManifest(manifest, manifestPath);
      expect(existsSync(manifestPath)).toBe(true);

      const loaded = readManifest(manifestPath);
      expect(loaded.name).toBe('roundtrip');
      expect(loaded.files).toHaveLength(1);
    });

    it('should throw for missing manifest', () => {
      expect(() => readManifest(join(tmpBase, 'nonexistent.yaml'))).toThrow('not found');
    });

    it('should throw for invalid manifest (missing name)', () => {
      const path = join(tmpBase, 'bad.yaml');
      writeFileSync(path, 'version: "1.0"\nfiles: []', 'utf-8');
      expect(() => readManifest(path)).toThrow('missing "name"');
    });

    it('should throw for invalid manifest (missing files)', () => {
      const path = join(tmpBase, 'bad2.yaml');
      writeFileSync(path, 'version: "1.0"\nname: test', 'utf-8');
      expect(() => readManifest(path)).toThrow('missing "files"');
    });

    it('should skip nonexistent files in manifest', () => {
      const manifest = createManifest(harnessDir, {
        name: 'partial',
        description: 'Partial',
        files: ['rules/nonexistent.md', 'rules/also-missing.md'],
      });
      expect(manifest.files).toHaveLength(0);
    });
  });

  describe('Pack/Unpack', () => {
    it('should pack a bundle from types', () => {
      createTestPrimitives();
      const bundle = packBundle(harnessDir, {
        name: 'rules-pack',
        description: 'Rules bundle',
        types: ['rules'],
      });

      expect(bundle.manifest.name).toBe('rules-pack');
      expect(bundle.files.length).toBeGreaterThanOrEqual(2);
      expect(bundle.manifest.types).toContain('rules');
    });

    it('should pack a bundle from specific files', () => {
      createTestPrimitives();
      const bundle = packBundle(harnessDir, {
        name: 'mixed-pack',
        description: 'Mixed bundle',
        files: ['rules/code-style.md', 'rules/be-concise.md'],
      });

      expect(bundle.files.length).toBe(2);
      expect(bundle.manifest.types).toContain('rules');
    });

    it('should write and read a bundle directory', () => {
      createTestPrimitives();
      const bundle = packBundle(harnessDir, {
        name: 'dir-bundle',
        description: 'Dir test',
        types: ['rules'],
      });

      const outputDir = join(tmpBase, 'output-bundle');
      writeBundleDir(bundle, outputDir);

      expect(existsSync(join(outputDir, 'manifest.yaml'))).toBe(true);
      expect(existsSync(join(outputDir, 'rules', 'code-style.md'))).toBe(true);
      expect(existsSync(join(outputDir, 'rules', 'testing.md'))).toBe(true);

      const loaded = readBundleDir(outputDir);
      expect(loaded.manifest.name).toBe('dir-bundle');
      expect(loaded.files.length).toBeGreaterThanOrEqual(2);
    });

    it('should handle empty types gracefully', () => {
      const bundle = packBundle(harnessDir, {
        name: 'empty',
        description: 'Empty',
        types: ['nonexistent-dir'],
      });

      expect(bundle.files).toHaveLength(0);
      expect(bundle.manifest.files).toHaveLength(0);
    });
  });

  describe('Install', () => {
    it('should install a bundle into a harness directory', () => {
      createTestPrimitives();
      const bundle = packBundle(harnessDir, {
        name: 'install-test',
        description: 'Install test',
        types: ['rules'],
      });

      // Create a fresh target harness
      const targetDir = join(tmpBase, 'target-agent');
      scaffoldHarness(targetDir, 'target');

      const result = installBundle(targetDir, bundle);
      expect(result.installed).toBe(true);
      expect(result.name).toBe('install-test');
      expect(result.files.length).toBe(3); // code-style, testing, be-concise
      expect(existsSync(join(targetDir, 'rules', 'code-style.md'))).toBe(true);
    });

    it('should skip existing files without overwrite', () => {
      createTestPrimitives();
      const bundle = packBundle(harnessDir, {
        name: 'skip-test',
        description: 'Skip test',
        files: ['rules/code-style.md'],
      });

      // Create target with conflicting file
      const targetDir = join(tmpBase, 'target2');
      scaffoldHarness(targetDir, 'target2');
      writeFileSync(join(targetDir, 'rules', 'code-style.md'), '# Existing');

      const result = installBundle(targetDir, bundle);
      expect(result.installed).toBe(true);
      expect(result.skipped).toContain('rules/code-style.md');
      expect(result.files).toHaveLength(0);

      // Original content preserved
      const content = readFileSync(join(targetDir, 'rules', 'code-style.md'), 'utf-8');
      expect(content).toBe('# Existing');
    });

    it('should overwrite files when overwrite=true', () => {
      createTestPrimitives();
      const bundle = packBundle(harnessDir, {
        name: 'overwrite-test',
        description: 'Overwrite test',
        files: ['rules/code-style.md'],
      });

      const targetDir = join(tmpBase, 'target3');
      scaffoldHarness(targetDir, 'target3');
      writeFileSync(join(targetDir, 'rules', 'code-style.md'), '# Old');

      const result = installBundle(targetDir, bundle, { overwrite: true });
      expect(result.files).toContain('rules/code-style.md');

      const content = readFileSync(join(targetDir, 'rules', 'code-style.md'), 'utf-8');
      expect(content).toContain('Code Style');
    });

    it('should record installation in .installed/', () => {
      createTestPrimitives();
      const bundle = packBundle(harnessDir, {
        name: 'record-test',
        description: 'Record test',
        types: ['rules'],
      });

      const targetDir = join(tmpBase, 'target4');
      scaffoldHarness(targetDir, 'target4');

      installBundle(targetDir, bundle);

      expect(existsSync(join(targetDir, '.installed', 'record-test.yaml'))).toBe(true);
      const manifests = readInstalledManifests(targetDir);
      expect(manifests.length).toBe(1);
      expect(manifests[0].name).toBe('record-test');
    });
  });

  describe('Uninstall', () => {
    it('should soft-delete by moving to archive/', () => {
      createTestPrimitives();
      const bundle = packBundle(harnessDir, {
        name: 'uninstall-test',
        description: 'Uninstall test',
        types: ['rules'],
      });

      const targetDir = join(tmpBase, 'target5');
      scaffoldHarness(targetDir, 'target5');
      installBundle(targetDir, bundle);

      // Verify files exist
      expect(existsSync(join(targetDir, 'rules', 'code-style.md'))).toBe(true);

      const result = uninstallBundle(targetDir, 'uninstall-test');
      expect(result.uninstalled).toBe(true);
      expect(result.archived.length).toBeGreaterThanOrEqual(2);

      // Files moved out of rules/
      expect(existsSync(join(targetDir, 'rules', 'code-style.md'))).toBe(false);

      // Files exist in archive
      expect(existsSync(join(targetDir, 'archive', 'uninstalled', 'uninstall-test', 'rules', 'code-style.md'))).toBe(true);
    });

    it('should fail for non-installed bundle', () => {
      const result = uninstallBundle(harnessDir, 'nonexistent');
      expect(result.uninstalled).toBe(false);
      expect(result.errors[0]).toContain('not installed');
    });

    it('should block uninstall when dependents exist', () => {
      createTestPrimitives();

      // Install a base bundle
      const baseBundle = packBundle(harnessDir, {
        name: 'base-rules',
        description: 'Base',
        types: ['rules'],
      });

      const targetDir = join(tmpBase, 'target6');
      scaffoldHarness(targetDir, 'target6');
      installBundle(targetDir, baseBundle);

      // Install a dependent bundle with a real file
      writeFileSync(join(targetDir, 'rules', 'dep-rule.md'), '---\nid: dep-rule\n---\n# Dep');
      const depManifest: BundleManifest = {
        version: '1.0',
        name: 'dependent',
        description: 'Depends on base-rules',
        author: 'test',
        bundle_version: '1.0.0',
        created: new Date().toISOString(),
        types: ['rules'],
        tags: [],
        files: [{ path: 'rules/dep-rule.md', type: 'rules', id: 'dep-rule', l0: 'Dep' }],
        dependencies: ['base-rules'],
      };
      const depBundle: PackedBundle = {
        manifest: depManifest,
        files: [{ path: 'rules/dep-rule.md', content: '---\nid: dep-rule\n---\n# Dep' }],
      };
      installBundle(targetDir, depBundle, { overwrite: true });

      // Try to uninstall base — should fail
      const result = uninstallBundle(targetDir, 'base-rules');
      expect(result.uninstalled).toBe(false);
      expect(result.dependents).toContain('dependent');
    });

    it('should hard delete when hard=true', () => {
      createTestPrimitives();
      const bundle = packBundle(harnessDir, {
        name: 'hard-delete',
        description: 'Hard delete test',
        files: ['rules/code-style.md'],
      });

      const targetDir = join(tmpBase, 'target7');
      scaffoldHarness(targetDir, 'target7');
      installBundle(targetDir, bundle);

      const result = uninstallBundle(targetDir, 'hard-delete', { hard: true });
      expect(result.uninstalled).toBe(true);
      expect(existsSync(join(targetDir, 'rules', 'code-style.md'))).toBe(false);
      // No archive created
      expect(existsSync(join(targetDir, 'archive', 'uninstalled', 'hard-delete'))).toBe(false);
    });
  });

  describe('Diff & Update', () => {
    it('should detect added/modified/removed files', () => {
      createTestPrimitives();
      const v1 = packBundle(harnessDir, {
        name: 'diff-test',
        description: 'v1',
        files: ['rules/code-style.md', 'rules/testing.md'],
      });

      const targetDir = join(tmpBase, 'target8');
      scaffoldHarness(targetDir, 'target8');
      installBundle(targetDir, v1);

      // Create v2: modify code-style, remove testing, add be-concise
      writeFileSync(
        join(harnessDir, 'rules', 'code-style.md'),
        '---\nid: code-style\ntags: [coding]\n---\n# Code Style v2\n\nUpdated.',
      );
      const v2 = packBundle(harnessDir, {
        name: 'diff-test',
        description: 'v2',
        version: '2.0.0',
        files: ['rules/code-style.md', 'rules/be-concise.md'],
      });

      const diff = diffBundle(targetDir, v2);
      expect(diff.modified).toContain('rules/code-style.md');
      expect(diff.added).toContain('rules/be-concise.md');
      expect(diff.removed).toContain('rules/testing.md');
    });

    it('should report unchanged files', () => {
      createTestPrimitives();
      const v1 = packBundle(harnessDir, {
        name: 'unchanged-test',
        description: 'v1',
        files: ['rules/code-style.md'],
      });

      const targetDir = join(tmpBase, 'target9');
      scaffoldHarness(targetDir, 'target9');
      installBundle(targetDir, v1);

      // Pack same content as v2
      const v2 = packBundle(harnessDir, {
        name: 'unchanged-test',
        description: 'v2',
        files: ['rules/code-style.md'],
      });

      const diff = diffBundle(targetDir, v2);
      expect(diff.unchanged).toContain('rules/code-style.md');
      expect(diff.modified).toHaveLength(0);
      expect(diff.added).toHaveLength(0);
    });

    it('should update an installed bundle', () => {
      createTestPrimitives();
      const v1 = packBundle(harnessDir, {
        name: 'update-test',
        description: 'v1',
        version: '1.0.0',
        files: ['rules/code-style.md'],
      });

      const targetDir = join(tmpBase, 'target10');
      scaffoldHarness(targetDir, 'target10');
      installBundle(targetDir, v1);

      // Create v2
      writeFileSync(
        join(harnessDir, 'rules', 'code-style.md'),
        '---\nid: code-style\n---\n# Code Style v2\n\nNew rules.',
      );
      const v2 = packBundle(harnessDir, {
        name: 'update-test',
        description: 'v2',
        version: '2.0.0',
        files: ['rules/code-style.md', 'rules/be-concise.md'],
      });

      const result = updateBundle(targetDir, v2);
      expect(result.updated).toBe(true);
      expect(result.oldVersion).toBe('1.0.0');
      expect(result.newVersion).toBe('2.0.0');
      expect(result.modified).toContain('rules/code-style.md');
      expect(result.added).toContain('rules/be-concise.md');

      // Verify content updated
      const content = readFileSync(join(targetDir, 'rules', 'code-style.md'), 'utf-8');
      expect(content).toContain('Code Style v2');
    });
  });

  describe('readInstalledManifests', () => {
    it('should return empty when .installed/ does not exist', () => {
      const manifests = readInstalledManifests(harnessDir);
      expect(manifests).toEqual([]);
    });

    it('should skip malformed manifest files', () => {
      mkdirSync(join(harnessDir, '.installed'), { recursive: true });
      writeFileSync(join(harnessDir, '.installed', 'bad.yaml'), 'just a string');
      writeFileSync(join(harnessDir, '.installed', 'good.yaml'),
        'version: "1.0"\nname: good-one\nfiles: []\nbundle_version: "1.0.0"\ndescription: ok\nauthor: test\ncreated: "2024-01-01"\ntypes: []\ntags: []\n');

      const manifests = readInstalledManifests(harnessDir);
      expect(manifests).toHaveLength(1);
      expect(manifests[0].name).toBe('good-one');
    });
  });

  describe('config registries field', () => {
    it('should parse config with registries', async () => {
      const { loadConfig } = await import('../src/core/config.js');
      const configPath = join(harnessDir, 'config.yaml');
      const content = readFileSync(configPath, 'utf-8');
      writeFileSync(configPath, content + '\nregistries:\n  - url: https://registry.example.com\n    name: Example\n  - url: https://other.example.com\n    token: secret123\n');

      const config = loadConfig(harnessDir);
      expect(config.registries).toHaveLength(2);
      expect(config.registries[0].url).toBe('https://registry.example.com');
      expect(config.registries[0].name).toBe('Example');
      expect(config.registries[1].url).toBe('https://other.example.com');
      expect(config.registries[1].token).toBe('secret123');
    });

    it('should default to empty registries array', async () => {
      const { loadConfig } = await import('../src/core/config.js');
      const config = loadConfig(harnessDir);
      expect(config.registries).toEqual([]);
    });
  });

  describe('listInstalledBundles', () => {
    it('should list installed bundles', () => {
      createTestPrimitives();
      const bundle = packBundle(harnessDir, {
        name: 'listed-bundle',
        description: 'Listed',
        version: '1.2.3',
        types: ['rules'],
      });

      const targetDir = join(tmpBase, 'target11');
      scaffoldHarness(targetDir, 'target11');
      installBundle(targetDir, bundle);

      const list = listInstalledBundles(targetDir);
      expect(list.length).toBe(1);
      expect(list[0].name).toBe('listed-bundle');
      expect(list[0].version).toBe('1.2.3');
      expect(list[0].types).toContain('rules');
    });

    it('should return empty for no installed bundles', () => {
      const list = listInstalledBundles(harnessDir);
      expect(list).toHaveLength(0);
    });
  });
});
