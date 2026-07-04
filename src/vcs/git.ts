import { execFileSync } from 'node:child_process';
import { DiffResult } from './types.js';

export type { DiffResult };

function git(repoPath: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function tryGit(repoPath: string, args: string[]): string | undefined {
  try {
    return git(repoPath, args);
  } catch {
    return undefined;
  }
}

/** Diff between two commits, fetching them first if the CI clone is shallow. */
export function diffBetween(repoPath: string, base: string, head: string): DiffResult {
  ensureCommit(repoPath, base);
  ensureCommit(repoPath, head);
  const mergeBase = tryGit(repoPath, ['merge-base', base, head])?.trim() ?? base;
  return {
    diff: git(repoPath, ['diff', '--no-color', mergeBase, head]),
    changedFiles: parseNameOnly(git(repoPath, ['diff', '--name-only', mergeBase, head])),
  };
}

/**
 * Local mode: diff of committed + uncommitted work against the merge-base
 * with `base`, i.e. what a PR from the current state would contain.
 */
export function diffLocal(repoPath: string, base: string): DiffResult {
  const mergeBase = tryGit(repoPath, ['merge-base', base, 'HEAD'])?.trim() ?? base;
  return {
    diff: git(repoPath, ['diff', '--no-color', mergeBase]),
    changedFiles: parseNameOnly(git(repoPath, ['diff', '--name-only', mergeBase])),
  };
}

function ensureCommit(repoPath: string, ref: string): void {
  if (tryGit(repoPath, ['cat-file', '-e', `${ref}^{commit}`]) !== undefined) return;
  // Shallow CI clones often miss the destination branch tip; try to fetch it.
  tryGit(repoPath, ['fetch', 'origin', ref]);
  if (tryGit(repoPath, ['cat-file', '-e', `${ref}^{commit}`]) === undefined) {
    throw new Error(
      `Commit ${ref} is not available locally (shallow clone?). ` +
        'Fetch the destination branch in your CI checkout step.',
    );
  }
}

function parseNameOnly(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}
