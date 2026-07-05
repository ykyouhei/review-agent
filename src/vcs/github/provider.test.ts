import { describe, expect, it } from 'vitest';
import { fingerprint, fingerprintMarker } from '../../core/findings.js';
import { PullRequestInfo } from '../types.js';
import { GitHubProvider, OctokitLike } from './provider.js';

const pr: PullRequestInfo = {
  id: '7',
  title: 'feat',
  description: 'desc',
  repository: 'org/app',
  sourceCommit: 'headsha',
  destinationCommit: 'basesha',
};

interface Recorded {
  method: string;
  params: Record<string, unknown>;
}

function fakeOctokit(handlers: Partial<Record<string, (params: never) => unknown>>) {
  const calls: Recorded[] = [];
  const invoke = (method: string, params: Record<string, unknown>): Promise<unknown> => {
    calls.push({ method, params });
    const handler = handlers[method];
    if (!handler) throw new Error(`Unexpected call ${method}`);
    return Promise.resolve(handler(params as never));
  };
  const octokit = {
    rest: {
      pulls: {
        get: (p: Record<string, unknown>) => invoke('pulls.get', p),
        listFiles: (p: Record<string, unknown>) => invoke('pulls.listFiles', p),
        listReviewComments: (p: Record<string, unknown>) => invoke('pulls.listReviewComments', p),
        createReview: (p: Record<string, unknown>) => invoke('pulls.createReview', p),
      },
      issues: {
        listComments: (p: Record<string, unknown>) => invoke('issues.listComments', p),
        createComment: (p: Record<string, unknown>) => invoke('issues.createComment', p),
      },
    },
  } as unknown as OctokitLike;
  return { octokit, calls };
}

function provider(octokit: OctokitLike): GitHubProvider {
  return new GitHubProvider({ repository: 'org/app', octokit });
}

describe('GitHubProvider constructor', () => {
  it('rejects malformed repository identifiers', () => {
    expect(() => new GitHubProvider({ repository: 'no-slash', octokit: {} as OctokitLike })).toThrow(
      /owner\/repo/,
    );
  });

  it('requires a token when no client is injected', () => {
    const original = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    try {
      expect(() => new GitHubProvider({ repository: 'org/app' })).toThrow(/GITHUB_TOKEN/);
    } finally {
      if (original.GITHUB_TOKEN) process.env.GITHUB_TOKEN = original.GITHUB_TOKEN;
      if (original.GH_TOKEN) process.env.GH_TOKEN = original.GH_TOKEN;
    }
  });
});

describe('getPullRequest', () => {
  it('maps the API response onto PullRequestInfo', async () => {
    const { octokit, calls } = fakeOctokit({
      'pulls.get': () => ({
        data: { title: 'feat: x', body: 'why', head: { sha: 'h1' }, base: { sha: 'b1' } },
      }),
    });
    const info = await provider(octokit).getPullRequest('7');
    expect(info).toMatchObject({
      id: '7',
      title: 'feat: x',
      description: 'why',
      repository: 'org/app',
      sourceCommit: 'h1',
      destinationCommit: 'b1',
    });
    expect(calls[0]?.params).toMatchObject({ owner: 'org', repo: 'app', pull_number: 7 });
  });
});

describe('getDiff', () => {
  it('fetches the unified diff and paginates the file list', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}.ts` }));
    const { octokit, calls } = fakeOctokit({
      'pulls.get': (params: { mediaType?: { format: string } }) => {
        expect(params.mediaType).toEqual({ format: 'diff' });
        return { data: 'diff --git a/f0.ts b/f0.ts\n+x\n' };
      },
      'pulls.listFiles': (params: { page: number }) =>
        params.page === 1 ? { data: page1 } : { data: [{ filename: 'last.ts' }] },
    });
    const result = await provider(octokit).getDiff(pr);
    expect(result.diff).toContain('diff --git');
    expect(result.changedFiles).toHaveLength(101);
    expect(result.changedFiles.at(-1)).toBe('last.ts');
    expect(calls.filter((c) => c.method === 'pulls.listFiles')).toHaveLength(2);
  });
});

describe('getExistingFingerprints', () => {
  it('collects markers from review comments and issue comments across pages', async () => {
    const a = { file: 'a.ts', category: 'bug', title: 'inline finding' };
    const b = { file: 'b.ts', category: 'bug', title: 'fallback finding' };
    const filler = Array.from({ length: 99 }, () => ({ body: 'noise' }));
    const { octokit } = fakeOctokit({
      'pulls.listReviewComments': (params: { page: number }) =>
        params.page === 1
          ? { data: [...filler, { body: `x ${fingerprintMarker(a)}` }] }
          : { data: [] },
      'issues.listComments': () => ({ data: [{ body: `y ${fingerprintMarker(b)}` }] }),
    });
    const result = await provider(octokit).getExistingFingerprints(pr);
    expect(result).toEqual(new Set([fingerprint(a), fingerprint(b)]));
  });
});

describe('postReview', () => {
  it('posts a single review with line-anchored comments', async () => {
    const { octokit, calls } = fakeOctokit({ 'pulls.createReview': () => ({}) });
    await provider(octokit).postReview(pr, {
      summary: 'overall',
      comments: [{ file: 'src/a.ts', line: 12, body: 'inline body' }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toMatchObject({
      commit_id: 'headsha',
      event: 'COMMENT',
      body: 'overall',
      comments: [{ path: 'src/a.ts', line: 12, side: 'RIGHT', body: 'inline body' }],
    });
  });

  it('falls back to one issue comment when the review is rejected (e.g. 422)', async () => {
    const { octokit, calls } = fakeOctokit({
      'pulls.createReview': () => {
        throw new Error('422 Unprocessable Entity');
      },
      'issues.createComment': () => ({}),
    });
    await provider(octokit).postReview(pr, {
      summary: 'overall',
      comments: [{ file: 'src/a.ts', line: 999, body: 'drifted <!-- review-agent:fp:aaaabbbbccccdddd -->' }],
    });
    const fallback = calls.find((c) => c.method === 'issues.createComment');
    expect(fallback?.params.body).toContain('overall');
    expect(fallback?.params.body).toContain('src/a.ts:999');
    expect(fallback?.params.body).toContain('review-agent:fp:aaaabbbbccccdddd');
  });

  it('posts the summary as an issue comment when there are no inline findings', async () => {
    const { octokit, calls } = fakeOctokit({ 'issues.createComment': () => ({}) });
    await provider(octokit).postReview(pr, { summary: 'all good', comments: [] });
    expect(calls[0]?.method).toBe('issues.createComment');
    expect(calls[0]?.params).toMatchObject({ issue_number: 7, body: 'all good' });
  });
});
