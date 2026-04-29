import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'fs';
import { join, basename, dirname, relative } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { CORE_PRIMITIVE_DIRS } from '../core/types.js';
import { parseHarnessDocument } from '../primitives/loader.js';
import { log } from '../core/logger.js';

// --- Manifest Types ---

export interface BundleManifest {
  /** Manifest format version */
  version: string;
  /** Bundle name (e.g., "code-review-rules") */
  name: string;
  /** Human-readable description */
  description: string;
  /** Author identifier */
  author: string;
  /** Semantic version (e.g., "1.0.0") */
  bundle_version: string;
  /** When this bundle was created */
  created: string;
  /** Primitive type(s) contained (e.g., ["rules", "instincts"]) */
  types: string[];
  /** Tags for search/discovery */
  tags: string[];
  /** Files included in this bundle (relative paths) */
  files: BundleFileEntry[];
  /** Optional dependencies (other bundle names) */
  dependencies?: string[];
  /** Optional registry URL this was published to */
  registry?: string;
  /** Optional license identifier */
  license?: string;
}

export interface BundleFileEntry {
  path: string;
  type: string;
  id: string;
  l0: string;
}

// --- Registry Types ---

export interface RegistryConfig {
  /** Registry URL (HTTPS) */
  url: string;
  /** Optional auth token */
  token?: string;
  /** Optional name for display */
  name?: string;
}

export interface BundleSearchResult {
  name: string;
  description: string;
  author: string;
  version: string;
  types: string[];
  tags: string[];
  download_url: string;
}

export interface BundleSearchResponse {
  results: BundleSearchResult[];
  total: number;
}

// --- Install / Uninstall Types ---

export interface PrimitiveInstallResult {
  installed: boolean;
  name: string;
  files: string[];
  skipped: string[];
  errors: string[];
  manifest?: BundleManifest;
}

export interface PrimitiveUninstallResult {
  uninstalled: boolean;
  name: string;
  archived: string[];
  dependents: string[];
  errors: string[];
}

export interface PrimitiveUpdateResult {
  updated: boolean;
  name: string;
  added: string[];
  modified: string[];
  removed: string[];
  errors: string[];
  oldVersion?: string;
  newVersion?: string;
}

// --- Manifest Operations ---

/**
 * Create a manifest.yaml for a set of primitive files.
 */
export function createManifest(
  harnessDir: string,
  options: {
    name: string;
    description: string;
    author?: string;
    version?: string;
    files: string[];
    tags?: string[];
    license?: string;
  },
): BundleManifest {
  const types = new Set<string>();
  const fileEntries: BundleFileEntry[] = [];

  for (const filePath of options.files) {
    const absPath = filePath.startsWith('/') ? filePath : join(harnessDir, filePath);
    if (!existsSync(absPath)) continue;

    const relPath = relative(harnessDir, absPath);
    const dir = relPath.split('/')[0];
    const type = (CORE_PRIMITIVE_DIRS as readonly string[]).includes(dir) ? dir : 'custom';
    types.add(type);

    try {
      const doc = parseHarnessDocument(absPath);
      fileEntries.push({
        path: relPath,
        type,
        id: doc.id,
        l0: doc.description ?? '',
      });
    } catch {
      fileEntries.push({
        path: relPath,
        type,
        id: basename(relPath, '.md'),
        l0: '',
      });
    }
  }

  return {
    version: '1.0',
    name: options.name,
    description: options.description,
    author: options.author ?? 'unknown',
    bundle_version: options.version ?? '1.0.0',
    created: new Date().toISOString(),
    types: [...types],
    tags: options.tags ?? [],
    files: fileEntries,
    license: options.license,
  };
}

/**
 * Write a manifest to a YAML file.
 */
export function writeManifest(manifest: BundleManifest, outputPath: string): void {
  writeFileSync(outputPath, stringifyYaml(manifest), 'utf-8');
}

/**
 * Read and validate a manifest from a YAML file.
 */
export function readManifest(manifestPath: string): BundleManifest {
  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }
  const content = readFileSync(manifestPath, 'utf-8');
  const parsed: unknown = parseYaml(content);

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Invalid manifest: not an object');
  }

  const manifest = parsed as Record<string, unknown>;
  if (typeof manifest.name !== 'string' || !manifest.name) {
    throw new Error('Invalid manifest: missing "name"');
  }
  if (typeof manifest.version !== 'string') {
    throw new Error('Invalid manifest: missing "version"');
  }
  if (!Array.isArray(manifest.files)) {
    throw new Error('Invalid manifest: missing "files" array');
  }

  return parsed as BundleManifest;
}

// --- Bundle Pack/Unpack ---

export interface PackedBundle {
  manifest: BundleManifest;
  files: Array<{ path: string; content: string }>;
}

/**
 * Pack a set of primitives into a bundle (manifest + file contents).
 */
export function packBundle(
  harnessDir: string,
  options: {
    name: string;
    description: string;
    author?: string;
    version?: string;
    files?: string[];
    types?: string[];
    tags?: string[];
    license?: string;
  },
): PackedBundle {
  let filePaths: string[] = options.files ?? [];

  // If types specified (or no types and no files), auto-collect all .md files from those dirs
  const types = (options.types && options.types.length > 0)
    ? options.types
    : (filePaths.length === 0 ? [...CORE_PRIMITIVE_DIRS] : []);
  if (types.length > 0 && filePaths.length === 0) {
    for (const type of types) {
      const dirPath = join(harnessDir, type);
      if (!existsSync(dirPath)) continue;
      const files = readdirSync(dirPath)
        .filter((f: string) => f.endsWith('.md') && !f.startsWith('_') && !f.startsWith('.'))
        .map((f: string) => join(type, f));
      filePaths.push(...files);
    }
  }

  const manifest = createManifest(harnessDir, {
    name: options.name,
    description: options.description,
    author: options.author,
    version: options.version,
    files: filePaths,
    tags: options.tags,
    license: options.license,
  });

  const files: Array<{ path: string; content: string }> = [];
  for (const entry of manifest.files) {
    const absPath = join(harnessDir, entry.path);
    if (existsSync(absPath)) {
      files.push({
        path: entry.path,
        content: readFileSync(absPath, 'utf-8'),
      });
    }
  }

  return { manifest, files };
}

/**
 * Write a packed bundle to a directory (manifest.yaml + files).
 */
export function writeBundleDir(bundle: PackedBundle, outputDir: string): void {
  mkdirSync(outputDir, { recursive: true });
  writeManifest(bundle.manifest, join(outputDir, 'manifest.yaml'));

  for (const file of bundle.files) {
    const targetPath = join(outputDir, file.path);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, file.content, 'utf-8');
  }
}

/**
 * Read a packed bundle from a directory containing manifest.yaml.
 */
export function readBundleDir(bundleDir: string): PackedBundle {
  const manifestPath = join(bundleDir, 'manifest.yaml');
  const manifest = readManifest(manifestPath);

  const files: Array<{ path: string; content: string }> = [];
  for (const entry of manifest.files) {
    const filePath = join(bundleDir, entry.path);
    if (existsSync(filePath)) {
      files.push({
        path: entry.path,
        content: readFileSync(filePath, 'utf-8'),
      });
    }
  }

  return { manifest, files };
}

// --- Install from Bundle ---

/**
 * Install primitives from a packed bundle into a harness directory.
 */
export function installBundle(
  harnessDir: string,
  bundle: PackedBundle,
  options?: { overwrite?: boolean; force?: boolean },
): PrimitiveInstallResult {
  const overwrite = options?.overwrite ?? false;
  const result: PrimitiveInstallResult = {
    installed: false,
    name: bundle.manifest.name,
    files: [],
    skipped: [],
    errors: [],
    manifest: bundle.manifest,
  };

  // Check for dependents
  if (bundle.manifest.dependencies && bundle.manifest.dependencies.length > 0 && !options?.force) {
    const installedPath = join(harnessDir, '.installed');
    if (existsSync(installedPath)) {
      const installed = readInstalledManifests(harnessDir);
      const installedNames = new Set(installed.map((m) => m.name));
      const missing = bundle.manifest.dependencies.filter((d) => !installedNames.has(d));
      if (missing.length > 0) {
        result.errors.push(`Missing dependencies: ${missing.join(', ')}. Use --force to install anyway.`);
        return result;
      }
    }
  }

  for (const file of bundle.files) {
    const targetPath = join(harnessDir, file.path);

    if (existsSync(targetPath) && !overwrite) {
      result.skipped.push(file.path);
      continue;
    }

    try {
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, file.content, 'utf-8');
      result.files.push(file.path);
    } catch (err) {
      result.errors.push(`${file.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Record installation
  if (result.files.length > 0 || result.skipped.length > 0) {
    result.installed = true;
    recordInstallation(harnessDir, bundle.manifest);
  }

  return result;
}

// --- Uninstall ---

/**
 * Uninstall (soft-delete) a previously installed bundle.
 * Moves files to archive/ instead of deleting.
 */
export function uninstallBundle(
  harnessDir: string,
  bundleName: string,
  options?: { hard?: boolean },
): PrimitiveUninstallResult {
  const result: PrimitiveUninstallResult = {
    uninstalled: false,
    name: bundleName,
    archived: [],
    dependents: [],
    errors: [],
  };

  // Find the installed manifest
  const installed = readInstalledManifests(harnessDir);
  const manifest = installed.find((m) => m.name === bundleName);
  if (!manifest) {
    result.errors.push(`Bundle "${bundleName}" is not installed`);
    return result;
  }

  // Check if other installed bundles depend on this one
  const dependents = installed.filter(
    (m) => m.name !== bundleName && m.dependencies?.includes(bundleName),
  );
  if (dependents.length > 0) {
    result.dependents = dependents.map((m) => m.name);
    result.errors.push(
      `Cannot uninstall: ${dependents.map((m) => m.name).join(', ')} depend(s) on "${bundleName}"`,
    );
    return result;
  }

  const archiveDir = join(harnessDir, 'archive', 'uninstalled', bundleName);

  for (const entry of manifest.files) {
    const filePath = join(harnessDir, entry.path);
    if (!existsSync(filePath)) continue;

    try {
      if (options?.hard) {
        unlinkSync(filePath);
      } else {
        // Soft delete — move to archive
        const archivePath = join(archiveDir, entry.path);
        mkdirSync(dirname(archivePath), { recursive: true });
        renameSync(filePath, archivePath);
      }
      result.archived.push(entry.path);
    } catch (err) {
      result.errors.push(`${entry.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Remove installation record
  if (result.archived.length > 0) {
    result.uninstalled = true;
    removeInstallationRecord(harnessDir, bundleName);
  }

  return result;
}

// --- Update ---

/**
 * Compare an installed bundle against a new version and produce a diff.
 */
export function diffBundle(
  harnessDir: string,
  newBundle: PackedBundle,
): { added: string[]; modified: string[]; removed: string[]; unchanged: string[] } {
  const installed = readInstalledManifests(harnessDir);
  const existing = installed.find((m) => m.name === newBundle.manifest.name);

  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  const unchanged: string[] = [];

  const existingFiles = new Set(existing?.files.map((f) => f.path) ?? []);
  const newFiles = new Set(newBundle.manifest.files.map((f) => f.path));

  // Check for added/modified files
  for (const file of newBundle.files) {
    const targetPath = join(harnessDir, file.path);
    if (!existingFiles.has(file.path)) {
      added.push(file.path);
    } else if (existsSync(targetPath)) {
      const currentContent = readFileSync(targetPath, 'utf-8');
      if (currentContent !== file.content) {
        modified.push(file.path);
      } else {
        unchanged.push(file.path);
      }
    } else {
      added.push(file.path);
    }
  }

  // Check for removed files
  for (const path of existingFiles) {
    if (!newFiles.has(path)) {
      removed.push(path);
    }
  }

  return { added, modified, removed, unchanged };
}

/**
 * Update an installed bundle to a new version.
 */
export function updateBundle(
  harnessDir: string,
  newBundle: PackedBundle,
  options?: { removeDeleted?: boolean },
): PrimitiveUpdateResult {
  const removeDeleted = options?.removeDeleted ?? false;
  const diff = diffBundle(harnessDir, newBundle);

  const result: PrimitiveUpdateResult = {
    updated: false,
    name: newBundle.manifest.name,
    added: [],
    modified: [],
    removed: [],
    errors: [],
  };

  // Find old version
  const installed = readInstalledManifests(harnessDir);
  const existing = installed.find((m) => m.name === newBundle.manifest.name);
  result.oldVersion = existing?.bundle_version;
  result.newVersion = newBundle.manifest.bundle_version;

  // Write added/modified files
  for (const path of [...diff.added, ...diff.modified]) {
    const file = newBundle.files.find((f) => f.path === path);
    if (!file) continue;

    const targetPath = join(harnessDir, path);
    try {
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, file.content, 'utf-8');
      if (diff.added.includes(path)) {
        result.added.push(path);
      } else {
        result.modified.push(path);
      }
    } catch (err) {
      result.errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Handle removed files
  if (removeDeleted) {
    const archiveDir = join(harnessDir, 'archive', 'updated', newBundle.manifest.name);
    for (const path of diff.removed) {
      const filePath = join(harnessDir, path);
      if (!existsSync(filePath)) continue;

      try {
        const archivePath = join(archiveDir, path);
        mkdirSync(dirname(archivePath), { recursive: true });
        renameSync(filePath, archivePath);
        result.removed.push(path);
      } catch (err) {
        result.errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (result.added.length > 0 || result.modified.length > 0 || result.removed.length > 0) {
    result.updated = true;
    recordInstallation(harnessDir, newBundle.manifest);
  }

  return result;
}

// --- Installation Record ---

const INSTALLED_DIR = '.installed';

/**
 * Record that a bundle was installed (writes manifest to .installed/).
 */
function recordInstallation(harnessDir: string, manifest: BundleManifest): void {
  const installedDir = join(harnessDir, INSTALLED_DIR);
  mkdirSync(installedDir, { recursive: true });
  const manifestPath = join(installedDir, `${manifest.name}.yaml`);
  writeFileSync(manifestPath, stringifyYaml(manifest), 'utf-8');
}

/**
 * Remove an installation record.
 */
function removeInstallationRecord(harnessDir: string, bundleName: string): void {
  const manifestPath = join(harnessDir, INSTALLED_DIR, `${bundleName}.yaml`);
  if (existsSync(manifestPath)) {
    unlinkSync(manifestPath);
  }
}

/**
 * Read all installed bundle manifests.
 */
export function readInstalledManifests(harnessDir: string): BundleManifest[] {
  const installedDir = join(harnessDir, INSTALLED_DIR);
  if (!existsSync(installedDir)) return [];

  const files = readdirSync(installedDir).filter((f: string) => f.endsWith('.yaml'));
  const manifests: BundleManifest[] = [];

  for (const file of files) {
    try {
      const manifest = readManifest(join(installedDir, file));
      manifests.push(manifest);
    } catch (err) {
      log.warn(`Failed to read installed manifest ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return manifests;
}

/**
 * List all installed bundles with summary info.
 */
export function listInstalledBundles(harnessDir: string): Array<{
  name: string;
  version: string;
  types: string[];
  fileCount: number;
  description: string;
}> {
  return readInstalledManifests(harnessDir).map((m) => ({
    name: m.name,
    version: m.bundle_version,
    types: m.types,
    fileCount: m.files.length,
    description: m.description,
  }));
}

// --- Remote Registry Client ---

/**
 * Fetch a bundle from a remote registry URL.
 */
export async function fetchRemoteBundle(url: string): Promise<PackedBundle> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch bundle: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    // JSON bundle format (legacy HarnessBundle format)
    const data: unknown = await response.json();
    if (typeof data !== 'object' || data === null || !('entries' in data)) {
      throw new Error('Invalid JSON bundle format');
    }

    const jsonBundle = data as { entries: Array<{ path: string; content: string }>; agent_name?: string };

    // Convert to PackedBundle with synthetic manifest
    const files = jsonBundle.entries;
    const types = new Set<string>();
    const fileEntries: BundleFileEntry[] = [];

    for (const entry of files) {
      const dir = entry.path.split('/')[0];
      const type = (CORE_PRIMITIVE_DIRS as readonly string[]).includes(dir) ? dir : 'custom';
      types.add(type);
      fileEntries.push({
        path: entry.path,
        type,
        id: basename(entry.path, '.md'),
        l0: '',
      });
    }

    const manifest: BundleManifest = {
      version: '1.0',
      name: jsonBundle.agent_name ?? 'remote-bundle',
      description: 'Imported from remote URL',
      author: 'unknown',
      bundle_version: '1.0.0',
      created: new Date().toISOString(),
      types: [...types],
      tags: [],
      files: fileEntries,
    };

    return { manifest, files };
  }

  // YAML manifest + files format (tar/zip would go here in future)
  // For now, treat as a single-file bundle
  const content = await response.text();
  const fileName = basename(new URL(url).pathname);

  const manifest: BundleManifest = {
    version: '1.0',
    name: basename(fileName, '.md'),
    description: `Downloaded from ${url}`,
    author: 'unknown',
    bundle_version: '1.0.0',
    created: new Date().toISOString(),
    types: ['custom'],
    tags: [],
    files: [{ path: fileName, type: 'custom', id: basename(fileName, '.md'), l0: '' }],
  };

  return { manifest, files: [{ path: fileName, content }] };
}

/**
 * Search a remote registry for bundles.
 */
export async function searchBundleRegistry(
  registryUrl: string,
  query: string,
  options?: { limit?: number; token?: string },
): Promise<BundleSearchResponse> {
  const limit = options?.limit ?? 20;
  const searchUrl = `${registryUrl}/api/bundles?search=${encodeURIComponent(query)}&limit=${limit}`;

  const headers: Record<string, string> = { 'Accept': 'application/json' };
  if (options?.token) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }

  const response = await fetch(searchUrl, { headers });
  if (!response.ok) {
    throw new Error(`Registry search failed: ${response.status} ${response.statusText}`);
  }

  return await response.json() as BundleSearchResponse;
}

/**
 * Fetch a bundle from a registry by name.
 */
export async function fetchFromRegistry(
  registryUrl: string,
  bundleName: string,
  options?: { version?: string; token?: string },
): Promise<PackedBundle> {
  const version = options?.version ?? 'latest';
  const bundleUrl = `${registryUrl}/api/bundles/${encodeURIComponent(bundleName)}/versions/${version}/download`;

  const headers: Record<string, string> = {};
  if (options?.token) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }

  const response = await fetch(bundleUrl, { headers });
  if (!response.ok) {
    throw new Error(`Failed to fetch bundle "${bundleName}": ${response.status} ${response.statusText}`);
  }

  const data: unknown = await response.json();
  return data as PackedBundle;
}

// --- Multi-Registry Support ---

export interface BundleSearchHit extends BundleSearchResult {
  /** Which registry URL this result came from */
  registryUrl: string;
  /** Display name of the registry */
  registryName: string;
}

export interface MultiBundleSearchResponse {
  results: BundleSearchHit[];
  total: number;
  registriesSearched: number;
  errors: Array<{ registry: string; error: string }>;
}

/**
 * Search all configured registries for bundles.
 * Merges results, deduplicating by name (first registry wins).
 */
export async function searchConfiguredRegistries(
  registries: Array<{ url: string; name?: string; token?: string }>,
  query: string,
  options?: { limit?: number },
): Promise<MultiBundleSearchResponse> {
  const limit = options?.limit ?? 20;
  const allResults: BundleSearchHit[] = [];
  const errors: Array<{ registry: string; error: string }> = [];
  const seenNames = new Set<string>();

  const searches = registries.map(async (reg) => {
    const displayName = reg.name ?? reg.url;
    try {
      const response = await searchBundleRegistry(reg.url, query, { limit, token: reg.token });
      return { registry: reg, displayName, response };
    } catch (err) {
      errors.push({
        registry: displayName,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  });

  const results = await Promise.allSettled(searches);

  for (const settled of results) {
    if (settled.status === 'fulfilled' && settled.value) {
      const { registry, displayName, response } = settled.value;
      for (const result of response.results) {
        if (!seenNames.has(result.name)) {
          seenNames.add(result.name);
          allResults.push({
            ...result,
            registryUrl: registry.url,
            registryName: displayName,
          });
        }
      }
    }
  }

  return {
    results: allResults.slice(0, limit),
    total: allResults.length,
    registriesSearched: registries.length,
    errors,
  };
}

/**
 * Install a bundle from configured registries by name.
 * Searches each registry in order, installs from the first match.
 */
export async function installFromRegistry(
  harnessDir: string,
  registries: Array<{ url: string; name?: string; token?: string }>,
  bundleName: string,
  options?: { version?: string; overwrite?: boolean; force?: boolean },
): Promise<PrimitiveInstallResult & { registryUrl?: string }> {
  for (const reg of registries) {
    try {
      const bundle = await fetchFromRegistry(reg.url, bundleName, {
        version: options?.version,
        token: reg.token,
      });
      const result = installBundle(harnessDir, bundle, {
        overwrite: options?.overwrite,
        force: options?.force,
      });
      return { ...result, registryUrl: reg.url };
    } catch {
      // Try next registry
      continue;
    }
  }

  return {
    installed: false,
    name: bundleName,
    files: [],
    skipped: [],
    errors: [`Bundle "${bundleName}" not found in any configured registry`],
  };
}
