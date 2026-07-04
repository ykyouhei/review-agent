import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffBetween, diffLocal } from './git.js';

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'review-agent-git-'));
  run(repo, ['init', '-q', '-b', 'main']);
  run(repo, ['config', 'user.email', 'test@example.com']);
  run(repo, ['config', 'user.name', 'test']);
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  run(repo, ['add', '.']);
  run(repo, ['commit', '-q', '-m', 'initial']);
  return repo;
}

describe('diffLocal', () => {
  it('includes committed and uncommitted changes against the merge-base', () => {
    const repo = makeRepo();
    run(repo, ['checkout', '-q', '-b', 'feature']);
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
    run(repo, ['commit', '-aqm', 'add two']);
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n');

    const result = diffLocal(repo, 'main');
    expect(result.changedFiles).toEqual(['a.txt']);
    expect(result.diff).toContain('+two');
    expect(result.diff).toContain('+three');
  });
});

describe('diffBetween', () => {
  it('diffs two commits via their merge base', () => {
    const repo = makeRepo();
    run(repo, ['checkout', '-q', '-b', 'feature']);
    writeFileSync(join(repo, 'b.txt'), 'feature\n');
    run(repo, ['add', '.']);
    run(repo, ['commit', '-qm', 'feature work']);
    const head = run(repo, ['rev-parse', 'HEAD']).trim();
    // Diverge main so merge-base resolution matters.
    run(repo, ['checkout', '-q', 'main']);
    writeFileSync(join(repo, 'a.txt'), 'main moved on\n');
    run(repo, ['commit', '-aqm', 'main change']);
    const main = run(repo, ['rev-parse', 'HEAD']).trim();

    const result = diffBetween(repo, main, head);
    expect(result.changedFiles).toEqual(['b.txt']);
    expect(result.diff).toContain('+feature');
    expect(result.diff).not.toContain('main moved on');
  });

  it('fails with a clear message for unknown commits', () => {
    const repo = makeRepo();
    expect(() => diffBetween(repo, 'deadbeef'.repeat(5), 'HEAD')).toThrow(/not available locally/);
  });
});
