import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './index.js';

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'review-agent-config-'));
}

describe('loadConfig', () => {
  it('returns defaults when no config file exists', () => {
    const config = loadConfig(tempRepo());
    expect(config.agent).toBe('claude');
    expect(config.vcs).toBe('codecommit');
    expect(config.review.maxComments).toBe(10);
    expect(config.review.minSeverity).toBe('minor');
    expect(config.knowledge.path).toBe('.review-agent/knowledge');
  });

  it('merges partial yaml over defaults', () => {
    const repo = tempRepo();
    writeFileSync(
      join(repo, '.review-agent.yml'),
      ['language: en', 'review:', '  maxComments: 3', 'codecommit:', '  repositoryName: my-repo'].join('\n'),
    );
    const config = loadConfig(repo);
    expect(config.language).toBe('en');
    expect(config.review.maxComments).toBe(3);
    expect(config.review.minConfidence).toBe(0.7);
    expect(config.codecommit.repositoryName).toBe('my-repo');
  });

  it('rejects invalid values with a readable error', () => {
    const repo = tempRepo();
    writeFileSync(join(repo, '.review-agent.yml'), 'review:\n  minSeverity: extreme\n');
    expect(() => loadConfig(repo)).toThrow(/minSeverity/);
  });
});
