import {
  CodeCommitClient,
  GetCommentsForPullRequestCommand,
  GetPullRequestCommand,
  PostCommentForPullRequestCommand,
} from '@aws-sdk/client-codecommit';
import { extractFingerprints } from '../../core/findings.js';
import { diffBetween } from '../git.js';
import { DiffResult, InlineComment, PullRequestInfo, ReviewToPost, VcsProvider } from '../types.js';

export interface CodeCommitProviderOptions {
  repositoryName: string;
  region?: string;
  /** Local checkout used to compute the diff (the CI workspace). */
  repoPath: string;
  /** Injectable for tests. */
  client?: Pick<CodeCommitClient, 'send'>;
}

/**
 * AWS CodeCommit provider. Auth rides the standard AWS credential chain, so
 * inside CodeBuild the job's IAM role is enough — no tokens to manage.
 * Requires: codecommit:GetPullRequest, GetCommentsForPullRequest,
 * PostCommentForPullRequest.
 */
export class CodeCommitProvider implements VcsProvider {
  private readonly client: Pick<CodeCommitClient, 'send'>;

  constructor(private readonly options: CodeCommitProviderOptions) {
    this.client =
      options.client ?? new CodeCommitClient(options.region ? { region: options.region } : {});
  }

  async getPullRequest(id: string): Promise<PullRequestInfo> {
    const response = await this.client.send(new GetPullRequestCommand({ pullRequestId: id }));
    const pr = response.pullRequest;
    const target = pr?.pullRequestTargets?.find(
      (t) => t.repositoryName === this.options.repositoryName,
    ) ?? pr?.pullRequestTargets?.[0];
    if (!pr || !target?.sourceCommit || !target.destinationCommit) {
      throw new Error(`Pull request ${id} has no resolvable source/destination commits`);
    }
    return {
      id,
      title: pr.title ?? '',
      description: pr.description ?? '',
      repository: target.repositoryName ?? this.options.repositoryName,
      sourceCommit: target.sourceCommit,
      destinationCommit: target.destinationCommit,
      mergeBase: target.mergeBase,
    };
  }

  /**
   * CodeCommit's GetDifferences returns file-level changes only, so the
   * unified diff is computed from the local CI checkout instead.
   */
  async getDiff(pr: PullRequestInfo): Promise<DiffResult> {
    return diffBetween(
      this.options.repoPath,
      pr.mergeBase ?? pr.destinationCommit,
      pr.sourceCommit,
    );
  }

  async getExistingFingerprints(pr: PullRequestInfo): Promise<Set<string>> {
    const fingerprints = new Set<string>();
    let nextToken: string | undefined;
    do {
      const response = await this.client.send(
        new GetCommentsForPullRequestCommand({ pullRequestId: pr.id, nextToken }),
      );
      for (const thread of response.commentsForPullRequestData ?? []) {
        for (const comment of thread.comments ?? []) {
          for (const fp of extractFingerprints(comment.content ?? '')) {
            fingerprints.add(fp);
          }
        }
      }
      nextToken = response.nextToken;
    } while (nextToken);
    return fingerprints;
  }

  async postReview(pr: PullRequestInfo, review: ReviewToPost): Promise<void> {
    const base = {
      pullRequestId: pr.id,
      repositoryName: pr.repository,
      beforeCommitId: pr.destinationCommit,
      afterCommitId: pr.sourceCommit,
    };

    if (review.summary.trim()) {
      await this.client.send(
        new PostCommentForPullRequestCommand({ ...base, content: review.summary }),
      );
    }

    for (const comment of review.comments) {
      try {
        await this.client.send(
          new PostCommentForPullRequestCommand({
            ...base,
            content: comment.body,
            location: {
              filePath: comment.file,
              filePosition: comment.line,
              relativeFileVersion: 'AFTER',
            },
          }),
        );
      } catch (error) {
        // A comment anchored to a line CodeCommit rejects (e.g. context drift)
        // should not sink the whole review — fall back to an unanchored one.
        await this.client.send(
          new PostCommentForPullRequestCommand({
            ...base,
            content: `${formatLocationFallback(comment)}\n\n${comment.body}`,
          }),
        );
        void error;
      }
    }
  }
}

function formatLocationFallback(comment: InlineComment): string {
  return `\`${comment.file}:${comment.line}\``;
}
