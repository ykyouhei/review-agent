import { describe, expect, it } from 'vitest';
import { detectCiContext, regionFromCodeCommitUrl, repositoryFromCodeCommitUrl } from './detect.js';

const CODECOMMIT_URL = 'https://git-codecommit.ap-northeast-1.amazonaws.com/v1/repos/my-app';

describe('detectCiContext', () => {
  it('prefers explicit REVIEW_AGENT_* variables', () => {
    const ctx = detectCiContext({
      REVIEW_AGENT_PR: '42',
      REVIEW_AGENT_REPO: 'my-app',
      AWS_REGION: 'us-east-1',
      CODEBUILD_BUILD_ID: 'ignored',
    });
    expect(ctx).toMatchObject({ pullRequestId: '42', repository: 'my-app', region: 'us-east-1' });
  });

  it('detects CodeBuild PR webhooks and CodeCommit repo/region from the URL', () => {
    const ctx = detectCiContext({
      CODEBUILD_BUILD_ID: 'build:1',
      CODEBUILD_WEBHOOK_TRIGGER: 'pr/123',
      CODEBUILD_SOURCE_REPO_URL: CODECOMMIT_URL,
    });
    expect(ctx).toMatchObject({
      pullRequestId: '123',
      repository: 'my-app',
      region: 'ap-northeast-1',
      source: 'codebuild',
    });
  });

  it('falls back to PULL_REQUEST_ID on CodeBuild without a webhook trigger', () => {
    const ctx = detectCiContext({
      CODEBUILD_BUILD_ID: 'build:1',
      PULL_REQUEST_ID: '7',
      AWS_REGION: 'ap-northeast-1',
    });
    expect(ctx.pullRequestId).toBe('7');
    expect(ctx.region).toBe('ap-northeast-1');
  });

  it('detects GitHub Actions pull_request refs', () => {
    const ctx = detectCiContext({
      GITHUB_ACTIONS: 'true',
      GITHUB_REF: 'refs/pull/55/merge',
      GITHUB_REPOSITORY: 'org/repo',
    });
    expect(ctx).toMatchObject({ pullRequestId: '55', repository: 'org/repo' });
  });

  it('returns empty context outside CI', () => {
    expect(detectCiContext({})).toEqual({});
  });
});

describe('codecommit url parsing', () => {
  it('extracts repo and region', () => {
    expect(repositoryFromCodeCommitUrl(CODECOMMIT_URL)).toBe('my-app');
    expect(regionFromCodeCommitUrl(CODECOMMIT_URL)).toBe('ap-northeast-1');
    expect(repositoryFromCodeCommitUrl('https://github.com/org/repo')).toBeUndefined();
  });
});
