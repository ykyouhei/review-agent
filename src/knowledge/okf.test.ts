import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import { describe, expect, it } from 'vitest';
import { KnowledgeStore } from './store.js';
import { generateIndex, readEntry, writeEntry } from './okf.js';

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'review-agent-okf-'));
}

describe('KnowledgeStore.init', () => {
  it('scaffolds an OKF bundle with a valid index', () => {
    const repo = tempRepo();
    const store = new KnowledgeStore(repo, '.review-agent/knowledge');
    store.init();

    expect(store.exists()).toBe(true);
    const index = matter(readFileSync(join(store.root, 'index.md'), 'utf8'));
    expect(index.data.type).toBe('index');
    expect(index.content).toContain('guidelines/review-policy.md');

    const starter = readEntry(store.root, 'guidelines/review-policy.md');
    expect(starter.frontmatter.type).toBe('guideline');
    expect(starter.frontmatter.timestamp).toBeTruthy();
  });
});

describe('okf entries and index', () => {
  it('round-trips entries and groups the index by type', () => {
    const repo = tempRepo();
    const store = new KnowledgeStore(repo, 'kb');
    store.init();

    writeEntry(store.root, {
      path: 'wiki/architecture.md',
      frontmatter: { type: 'wiki', title: 'Architecture', tags: ['core'] },
      body: 'Layers: cli -> core -> adapters. See [policy](../guidelines/review-policy.md).',
    });

    const entry = readEntry(store.root, 'wiki/architecture.md');
    expect(entry.frontmatter.title).toBe('Architecture');
    expect(entry.body).toContain('Layers');

    const index = generateIndex(store.root);
    expect(index).toContain('## wiki');
    expect(index).toContain('[Architecture](wiki/architecture.md) — core');
    expect(index).toContain('## guideline');
    expect(index).not.toContain('index.md');
  });
});
