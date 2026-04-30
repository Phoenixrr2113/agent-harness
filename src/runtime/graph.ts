import { existsSync } from 'fs';
import { join, relative } from 'path';
import { loadDirectoryWithErrors } from '../primitives/loader.js';
import { getPrimitiveDirs } from '../core/types.js';
import type { HarnessConfig } from '../core/types.js';

export interface GraphNode {
  id: string;
  directory: string;
  path: string;
  tags: string[];
  status: string;
  description: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: 'related' | 'with';
}

export interface DependencyGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  orphans: string[];
  clusters: string[][];
}

export interface GraphStats {
  totalNodes: number;
  totalEdges: number;
  orphanCount: number;
  clusterCount: number;
  mostConnected: Array<{ id: string; connections: number }>;
  brokenRefs: Array<{ from: string; ref: string }>;
}

/**
 * Build a dependency graph from all primitives in the harness.
 * Analyzes `related:` and `with:` frontmatter fields to create edges.
 */
export function buildDependencyGraph(harnessDir: string, config?: HarnessConfig): DependencyGraph {
  const dirs = getPrimitiveDirs(config);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeIds = new Set<string>();

  // Load all primitives
  for (const dir of dirs) {
    const fullPath = join(harnessDir, dir);
    if (!existsSync(fullPath)) continue;

    const { docs } = loadDirectoryWithErrors(fullPath);
    for (const doc of docs) {
      nodeIds.add(doc.id);
      nodes.push({
        id: doc.id,
        directory: dir,
        path: relative(harnessDir, doc.path),
        tags: doc.tags,
        status: doc.status,
        description: doc.description ?? doc.id,
      });
    }
  }

  // Build edges from related: and with: fields
  for (const dir of dirs) {
    const fullPath = join(harnessDir, dir);
    if (!existsSync(fullPath)) continue;

    const { docs } = loadDirectoryWithErrors(fullPath);
    for (const doc of docs) {
      const fromId = doc.id;

      // related: field edges
      for (const ref of doc.related) {
        const targetId = resolveRef(ref, nodeIds, harnessDir);
        if (targetId) {
          edges.push({ from: fromId, to: targetId, type: 'related' });
        }
      }

      // with: field edges (agent delegation reference)
      if (doc.with) {
        const withRef = doc.with;
        const targetId = resolveRef(withRef, nodeIds, harnessDir);
        if (targetId) {
          edges.push({ from: fromId, to: targetId, type: 'with' });
        }
      }
    }
  }

  // Find orphans (nodes with no edges in or out)
  const connected = new Set<string>();
  for (const edge of edges) {
    connected.add(edge.from);
    connected.add(edge.to);
  }
  const orphans = nodes
    .filter((n) => !connected.has(n.id))
    .map((n) => n.id);

  // Find clusters (connected components)
  const clusters = findClusters(nodes, edges);

  return { nodes, edges, orphans, clusters };
}

/**
 * Resolve a reference to a node ID. Handles:
 * - Direct ID match (e.g., "tool-github")
 * - Path-style refs (e.g., "skills/code-review" or "agents/reviewer")
 */
function resolveRef(ref: string, knownIds: Set<string>, harnessDir: string): string | null {
  // Direct ID match
  if (knownIds.has(ref)) return ref;

  // Path-style ref: extract the filename part as potential ID
  if (ref.includes('/')) {
    const parts = ref.split('/');
    const filename = parts[parts.length - 1].replace(/\.md$/, '');
    if (knownIds.has(filename)) return filename;

    // Try with directory prefix as part of ID
    const withDir = parts.join('-');
    if (knownIds.has(withDir)) return withDir;
  }

  return null;
}

/**
 * Find connected components using union-find.
 */
function findClusters(nodes: GraphNode[], edges: GraphEdge[]): string[][] {
  const parent = new Map<string, string>();

  for (const node of nodes) {
    parent.set(node.id, node.id);
  }

  function find(id: string): string {
    let root = id;
    while (parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    // Path compression
    let current = id;
    while (current !== root) {
      const next = parent.get(current)!;
      parent.set(current, root);
      current = next;
    }
    return root;
  }

  function union(a: string, b: string): void {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      parent.set(rootA, rootB);
    }
  }

  for (const edge of edges) {
    if (parent.has(edge.from) && parent.has(edge.to)) {
      union(edge.from, edge.to);
    }
  }

  // Group by root
  const groups = new Map<string, string[]>();
  for (const node of nodes) {
    const root = find(node.id);
    if (!groups.has(root)) {
      groups.set(root, []);
    }
    groups.get(root)!.push(node.id);
  }

  // Return only clusters with more than 1 member (singletons are orphans)
  return Array.from(groups.values())
    .filter((g) => g.length > 1)
    .sort((a, b) => b.length - a.length);
}

/**
 * Get statistics about the dependency graph.
 */
export function getGraphStats(harnessDir: string, config?: HarnessConfig): GraphStats {
  const graph = buildDependencyGraph(harnessDir, config);

  // Count connections per node
  const connectionCount = new Map<string, number>();
  for (const node of graph.nodes) {
    connectionCount.set(node.id, 0);
  }
  for (const edge of graph.edges) {
    connectionCount.set(edge.from, (connectionCount.get(edge.from) ?? 0) + 1);
    connectionCount.set(edge.to, (connectionCount.get(edge.to) ?? 0) + 1);
  }

  const mostConnected = Array.from(connectionCount.entries())
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, connections]) => ({ id, connections }));

  // Find broken references (references that didn't resolve to known IDs)
  const brokenRefs: Array<{ from: string; ref: string }> = [];
  const nodeIds = new Set(graph.nodes.map((n) => n.id));

  for (const dir of getPrimitiveDirs(config)) {
    const fullPath = join(harnessDir, dir);
    if (!existsSync(fullPath)) continue;

    const { docs } = loadDirectoryWithErrors(fullPath);
    for (const doc of docs) {
      for (const ref of doc.related) {
        const resolved = resolveRef(ref, nodeIds, harnessDir);
        if (!resolved) {
          brokenRefs.push({ from: doc.id, ref });
        }
      }
      if (doc.with) {
        const resolved = resolveRef(doc.with, nodeIds, harnessDir);
        if (!resolved) {
          brokenRefs.push({ from: doc.id, ref: doc.with });
        }
      }
    }
  }

  return {
    totalNodes: graph.nodes.length,
    totalEdges: graph.edges.length,
    orphanCount: graph.orphans.length,
    clusterCount: graph.clusters.length,
    mostConnected,
    brokenRefs,
  };
}
