export interface DetectedContext {
  pullRequestId?: string;
  repository?: string;
  region?: string;
  source?: string;
}

/**
 * Detect the pull request and repository from CI environment variables so the
 * CLI works with a bare `review-agent review` on any CI service.
 */
export function detectCiContext(env: NodeJS.ProcessEnv = process.env): DetectedContext {
  // Explicit override, works on any CI.
  if (env.REVIEW_AGENT_PR) {
    return {
      pullRequestId: env.REVIEW_AGENT_PR,
      repository: env.REVIEW_AGENT_REPO,
      region: env.REVIEW_AGENT_REGION ?? env.AWS_REGION,
      source: 'env:REVIEW_AGENT_PR',
    };
  }

  // AWS CodeBuild. Webhook trigger is "pr/123"; CodeCommit triggers may pass
  // the PR id through a custom variable instead.
  if (env.CODEBUILD_BUILD_ID) {
    const trigger = env.CODEBUILD_WEBHOOK_TRIGGER ?? env.CODEBUILD_SOURCE_VERSION ?? '';
    const match = trigger.match(/^pr\/(\d+)$/);
    return {
      pullRequestId: match?.[1] ?? env.PULL_REQUEST_ID,
      repository: repositoryFromCodeCommitUrl(env.CODEBUILD_SOURCE_REPO_URL),
      region: regionFromCodeCommitUrl(env.CODEBUILD_SOURCE_REPO_URL) ?? env.AWS_REGION,
      source: 'codebuild',
    };
  }

  // Codemagic.
  if (env.CM_BUILD_ID) {
    return {
      pullRequestId: env.CM_PULL_REQUEST_NUMBER,
      repository: repositoryFromCodeCommitUrl(env.CM_REPO_URL),
      region: regionFromCodeCommitUrl(env.CM_REPO_URL) ?? env.AWS_REGION,
      source: 'codemagic',
    };
  }

  // GitHub Actions (relevant once the github provider lands).
  if (env.GITHUB_ACTIONS) {
    const match = env.GITHUB_REF?.match(/^refs\/pull\/(\d+)\//);
    return {
      pullRequestId: match?.[1],
      repository: env.GITHUB_REPOSITORY,
      source: 'github-actions',
    };
  }

  // GitLab CI.
  if (env.GITLAB_CI) {
    return {
      pullRequestId: env.CI_MERGE_REQUEST_IID,
      repository: env.CI_PROJECT_PATH,
      source: 'gitlab-ci',
    };
  }

  return {};
}

/** https://git-codecommit.<region>.amazonaws.com/v1/repos/<name> -> <name> */
export function repositoryFromCodeCommitUrl(url?: string): string | undefined {
  const match = url?.match(/git-codecommit\.[^/]+\.amazonaws\.com\/v1\/repos\/([^/?#]+)/);
  return match?.[1];
}

export function regionFromCodeCommitUrl(url?: string): string | undefined {
  const match = url?.match(/git-codecommit\.([^.]+)\.amazonaws\.com/);
  return match?.[1];
}
