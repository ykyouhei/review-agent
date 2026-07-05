import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentRunner, ReviewTask } from '../agent/types.js';
import { configSchema } from '../config/index.js';
import { KnowledgeStore } from '../knowledge/store.js';
import { DiffResult, PullRequestInfo, ReviewToPost, VcsProvider } from '../vcs/types.js';
import { Finding, ReviewOutput, fingerprint } from './findings.js';
import { reviewPullRequest } from './orchestrator.js';

const diff: DiffResult = {
  diff: 'diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n+const x = 1;\n',
  changedFiles: ['src/a.ts'],
};

function finding(overrides: Partial<Finding>): Finding {
  return {
    file: 'src/a.ts',
    startLine: 1,
    endLine: 1,
    severity: 'major',
    category: 'bug',
    title: 'title',
    body: 'body',
    confidence: 0.9,
    ...overrides,
  };
}

class FakeRunner implements AgentRunner {
  lastTask?: ReviewTask;
  constructor(private readonly output: ReviewOutput) {}
  review(task: ReviewTask): Promise<ReviewOutput> {
    this.lastTask = task;
    return Promise.resolve(this.output);
  }
  generateWiki(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeProvider implements VcsProvider {
  posted?: ReviewToPost;
  constructor(private readonly fingerprints = new Set<string>()) {}
  getPullRequest(id: string): Promise<PullRequestInfo> {
    return Promise.resolve({
      id,
      title: 'PR title',
      description: 'PR body',
      repository: 'repo',
      sourceCommit: 's',
      destinationCommit: 'd',
    });
  }
  getDiff(): Promise<DiffResult> {
    return Promise.resolve(diff);
  }
  getExistingFingerprints(): Promise<Set<string>> {
    return Promise.resolve(this.fingerprints);
  }
  postReview(_pr: PullRequestInfo, review: ReviewToPost): Promise<void> {
    this.posted = review;
    return Promise.resolve();
  }
}

function deps(runner: AgentRunner, repoPath = mkdtempSync(join(tmpdir(), 'review-agent-orch-'))) {
  return { repoPath, config: configSchema.parse({}), runner };
}

describe('reviewPullRequest', () => {
  it('runs the full pipeline and posts filtered findings with fingerprint markers', async () => {
    const runner = new FakeRunner({
      summary: 'まとめ',
      findings: [
        finding({ title: 'real bug' }),
        finding({ title: 'weak guess', confidence: 0.2 }),
      ],
    });
    const provider = new FakeProvider();
    const result = await reviewPullRequest(deps(runner), provider, '1', { dryRun: false });

    expect(runner.lastTask?.title).toBe('PR title');
    expect(runner.lastTask?.diff).toContain('const x = 1;');
    expect(result.posted).toBe(true);
    expect(provider.posted?.summary).toContain('まとめ');
    expect(provider.posted?.comments).toHaveLength(1);
    expect(provider.posted?.comments[0]?.body).toContain('review-agent:fp:');
    expect(provider.posted?.comments[0]?.body).toContain('real bug');
  });

  it('skips findings already posted in a previous run', async () => {
    const dup = finding({ title: 'already reported' });
    const runner = new FakeRunner({ summary: 's', findings: [dup] });
    const provider = new FakeProvider(new Set([fingerprint(dup)]));
    const result = await reviewPullRequest(deps(runner), provider, '1', { dryRun: false });
    expect(result.filter.kept).toHaveLength(0);
    expect(result.filter.dropped[0]?.reason).toBe('duplicate');
  });

  it('does not post in dry-run mode', async () => {
    const runner = new FakeRunner({ summary: 's', findings: [finding({})] });
    const provider = new FakeProvider();
    const result = await reviewPullRequest(deps(runner), provider, '1', { dryRun: true });
    expect(result.posted).toBe(false);
    expect(provider.posted).toBeUndefined();
  });

  it('injects the knowledge index into the task when the bundle exists', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'review-agent-orch-kb-'));
    const store = new KnowledgeStore(repoPath, '.review-agent/knowledge');
    store.init();

    const runner = new FakeRunner({ summary: 's', findings: [] });
    await reviewPullRequest(deps(runner, repoPath), new FakeProvider(), '1', { dryRun: true });
    expect(runner.lastTask?.knowledgeIndex).toContain('Knowledge Index');
    expect(runner.lastTask?.knowledgePath).toBe('.review-agent/knowledge');
  });
});
