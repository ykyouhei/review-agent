export interface PullRequestInfo {
  id: string;
  title: string;
  description: string;
  /** Repository identifier in provider-native form (e.g. CodeCommit repository name). */
  repository: string;
  /** Head commit of the PR source branch. */
  sourceCommit: string;
  /** Commit the PR will merge into (destination branch tip). */
  destinationCommit: string;
  /** Common ancestor used as the diff base, when the provider exposes it. */
  mergeBase?: string;
}

export interface InlineComment {
  file: string;
  /** Line in the post-change file. */
  line: number;
  body: string;
}

export interface ReviewToPost {
  summary: string;
  comments: InlineComment[];
}

export interface DiffResult {
  diff: string;
  changedFiles: string[];
}

export interface VcsProvider {
  getPullRequest(id: string): Promise<PullRequestInfo>;
  getDiff(pr: PullRequestInfo): Promise<DiffResult>;
  /**
   * Fingerprints extracted from comments this tool posted on the PR in
   * previous runs; used to avoid repeating the same finding.
   */
  getExistingFingerprints(pr: PullRequestInfo): Promise<Set<string>>;
  postReview(pr: PullRequestInfo, review: ReviewToPost): Promise<void>;
}
