import { DiffResult, PullRequestInfo, ReviewToPost, VcsProvider } from '../types.js';

/**
 * Placeholder for the GitHub provider (Octokit: pulls.get, pulls.listReviewComments,
 * pulls.createReview with line-anchored comments). Planned for phase 2.
 */
export class GitHubProvider implements VcsProvider {
  getPullRequest(_id: string): Promise<PullRequestInfo> {
    return Promise.reject(new Error('The github provider is not implemented yet. Use `vcs: codecommit`.'));
  }

  getDiff(_pr: PullRequestInfo): Promise<DiffResult> {
    return Promise.reject(new Error('The github provider is not implemented yet.'));
  }

  getExistingFingerprints(_pr: PullRequestInfo): Promise<Set<string>> {
    return Promise.reject(new Error('The github provider is not implemented yet.'));
  }

  postReview(_pr: PullRequestInfo, _review: ReviewToPost): Promise<void> {
    return Promise.reject(new Error('The github provider is not implemented yet.'));
  }
}
