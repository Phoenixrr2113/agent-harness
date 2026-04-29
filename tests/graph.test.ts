import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { buildDependencyGraph, getGraphStats } from '../src/runtime/graph.js';

const TEST_DIR = join(__dirname, '__test_graph__');

function makePrimitive(id: string, related: string[] = [], withAgent?: string): string {
  const relatedField = related.length > 0 ? `related: [${related.join(', ')}]` : 'related: []';
  const withField = withAgent ? `with: ${withAgent}` : '';
  return `---
id: ${id}
tags: [test]
author: human
status: active
${relatedField}
${withField}
---
<!-- L0: ${id} summary -->

# ${id}
Body content.
`;
}

describe('graph', () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, 'rules'), { recursive: true });
    mkdirSync(join(TEST_DIR, 'skills'), { recursive: true });
    mkdirSync(join(TEST_DIR, 'workflows'), { recursive: true });
    mkdirSync(join(TEST_DIR, 'agents'), { recursive: true });
    mkdirSync(join(TEST_DIR, 'tools'), { recursive: true });
    mkdirSync(join(TEST_DIR, 'instincts'), { recursive: true });
    mkdirSync(join(TEST_DIR, 'playbooks'), { recursive: true });
    writeFileSync(join(TEST_DIR, 'CORE.md'), '# Core', 'utf-8');
    writeFileSync(
      join(TEST_DIR, 'config.yaml'),
      `agent:\n  name: test\n  version: "0.1.0"\nmodel:\n  provider: openrouter\n  id: test-model\n  max_tokens: 200000\n`,
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('should build graph from connected primitives', () => {
    writeFileSync(join(TEST_DIR, 'rules', 'ops.md'), makePrimitive('ops', ['code-review']), 'utf-8');
    writeFileSync(join(TEST_DIR, 'rules', 'code-review.md'), makePrimitive('code-review', ['ops']), 'utf-8');

    const graph = buildDependencyGraph(TEST_DIR);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(2); // ops->code-review and code-review->ops
    expect(graph.orphans).toHaveLength(0);
  });

  it('should identify orphan nodes', () => {
    writeFileSync(join(TEST_DIR, 'rules', 'ops.md'), makePrimitive('ops', ['code-review']), 'utf-8');
    writeFileSync(join(TEST_DIR, 'skills', 'code-review.md'), makePrimitive('code-review', ['ops']), 'utf-8');
    writeFileSync(join(TEST_DIR, 'skills', 'research.md'), makePrimitive('research'), 'utf-8');

    const graph = buildDependencyGraph(TEST_DIR);
    expect(graph.orphans).toHaveLength(1);
    expect(graph.orphans[0]).toBe('research');
  });

  it('should detect with: agent references as edges', () => {
    writeFileSync(join(TEST_DIR, 'agents', 'reviewer.md'), makePrimitive('reviewer'), 'utf-8');
    writeFileSync(join(TEST_DIR, 'workflows', 'review.md'), makePrimitive('review', [], 'reviewer'), 'utf-8');

    const graph = buildDependencyGraph(TEST_DIR);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].from).toBe('review');
    expect(graph.edges[0].to).toBe('reviewer');
    expect(graph.edges[0].type).toBe('with');
    expect(graph.orphans).toHaveLength(0);
  });

  it('should find clusters (connected components)', () => {
    // Cluster 1: a <-> b
    writeFileSync(join(TEST_DIR, 'rules', 'a.md'), makePrimitive('a', ['b']), 'utf-8');
    writeFileSync(join(TEST_DIR, 'rules', 'b.md'), makePrimitive('b', ['a']), 'utf-8');
    // Cluster 2: c <-> d
    writeFileSync(join(TEST_DIR, 'instincts', 'c.md'), makePrimitive('c', ['d']), 'utf-8');
    writeFileSync(join(TEST_DIR, 'instincts', 'd.md'), makePrimitive('d', ['c']), 'utf-8');
    // Orphan: e
    writeFileSync(join(TEST_DIR, 'tools', 'e.md'), makePrimitive('e'), 'utf-8');

    const graph = buildDependencyGraph(TEST_DIR);
    expect(graph.clusters).toHaveLength(2);
    expect(graph.orphans).toHaveLength(1);
    expect(graph.orphans[0]).toBe('e');
  });

  it('should return empty graph for empty harness', () => {
    const graph = buildDependencyGraph(TEST_DIR);
    expect(graph.nodes).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
    expect(graph.orphans).toHaveLength(0);
    expect(graph.clusters).toHaveLength(0);
  });

  it('should compute graph stats', () => {
    writeFileSync(join(TEST_DIR, 'rules', 'ops.md'), makePrimitive('ops', ['code-review', 'research']), 'utf-8');
    writeFileSync(join(TEST_DIR, 'rules', 'code-review.md'), makePrimitive('code-review', ['ops']), 'utf-8');
    writeFileSync(join(TEST_DIR, 'rules', 'research.md'), makePrimitive('research', ['ops']), 'utf-8');

    const stats = getGraphStats(TEST_DIR);
    expect(stats.totalNodes).toBe(3);
    expect(stats.totalEdges).toBe(4); // ops->code-review, ops->research, code-review->ops, research->ops
    expect(stats.orphanCount).toBe(0);
    expect(stats.clusterCount).toBe(1);
    expect(stats.mostConnected.length).toBeGreaterThan(0);
    expect(stats.mostConnected[0].id).toBe('ops');
  });

  it('should detect broken references', () => {
    writeFileSync(join(TEST_DIR, 'rules', 'ops.md'), makePrimitive('ops', ['nonexistent', 'also-missing']), 'utf-8');

    const stats = getGraphStats(TEST_DIR);
    expect(stats.brokenRefs).toHaveLength(2);
    expect(stats.brokenRefs[0].from).toBe('ops');
    expect(stats.brokenRefs[0].ref).toBe('nonexistent');
  });

  it('should handle single-node graph correctly', () => {
    writeFileSync(join(TEST_DIR, 'rules', 'solo.md'), makePrimitive('solo'), 'utf-8');

    const graph = buildDependencyGraph(TEST_DIR);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.orphans).toHaveLength(1);
    expect(graph.clusters).toHaveLength(0); // Single nodes don't form clusters
  });
});
