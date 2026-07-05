import { Octokit } from '@octokit/rest';
import { extractFingerprints } from '../../core/findings.js';
import { DiffResult, PullRequestInfo, ReviewToPost, VcsProvider } from '../types.js';

/**
 * The narrow slice of the Octokit surface this provider uses; injectable for
 * tests. Method syntax keeps parameters bivariant so a real Octokit instance
 * remains assignable.
 */
export interface OctokitLike {
  rest: {
    pulls: {
      get(params: {
        owner: string;
        repo: string;
        pull_number: number;
        mediaType?: { format: string };
      }): Promise<{ data: unknown }>;
      listFiles(params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page: number;
        page: number;
      }): Promise<{ data: { filename: string }[] }>;
      listReviewComments(params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page: number;
        page: number;
      }): Promise<{ data: { body?: string }[] }>;
      createReview(params: {
        owner: string;
        repo: string;
        pull_number: number;
        commit_id: string;
        event: 'COMMENT';
        body: string;
        comments: { path: string; line: number; side: 'RIGHT'; body: string }[];
      }): Promise<unknown>;
    };
    issues: {
      listComments(params: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page: number;
        page: number;
      }): Promise<{ data: { body?: string }[] }>;
      createComment(params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }): Promise<unknown>;
    };
  };
}

export interface GitHubProviderOptions {
  /** "owner/repo" */
  repository: string;
  /** Defaults to GITHUB_TOKEN / GH_TOKEN. */
  token?: string;
  /** GitHub Enterprise Server API root, e.g. https://ghe.example.com/api/v3 */
  baseUrl?: string;
  /** Injectable for tests. */
  octokit?: OctokitLike;
}

const PER_PAGE = 100;

/**
 * GitHub provider. The diff and file list come from the API rather than the
 * local checkout because actions/checkout defaults to a shallow clone of a
 * synthetic merge commit, which breaks local merge-base diffs.
 */
export class GitHubProvider implements VcsProvider {
  private readonly octokit: OctokitLike;
  private readonly owner: string;
  private readonly repo: string;

  constructor(options: GitHubProviderOptions) {
    const [owner, repo] = options.repository.split('/');
    if (!owner || !repo) {
      throw new Error(`GitHub repository must be "owner/repo", got "${options.repository}"`);
    }
    this.owner = owner;
    this.repo = repo;

    if (options.octokit) {
      this.octokit = options.octokit;
    } else {
      const token = options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
      if (!token) {
        throw new Error(
          'GitHub token is required. Set GITHUB_TOKEN (or GH_TOKEN) with pull-requests: write access.',
        );
      }
      this.octokit = new Octokit({ auth: token, baseUrl: options.baseUrl });
    }
  }

  async getPullRequest(id: string): Promise<PullRequestInfo> {
    const { data } = await this.octokit.rest.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: Number(id),
    });
    const pr = data as {
      title?: string;
      body?: string | null;
      head: { sha: string };
      base: { sha: string };
    };
    return {
      id,
      title: pr.title ?? '',
      description: pr.body ?? '',
      repository: `${this.owner}/${this.repo}`,
      sourceCommit: pr.head.sha,
      destinationCommit: pr.base.sha,
    };
  }

  async getDiff(pr: PullRequestInfo): Promise<DiffResult> {
    const { data } = await this.octokit.rest.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: Number(pr.id),
      mediaType: { format: 'diff' },
    });

    const changedFiles: string[] = [];
    for (let page = 1; ; page += 1) {
      const response = await this.octokit.rest.pulls.listFiles({
        owner: this.owner,
        repo: this.repo,
        pull_number: Number(pr.id),
        per_page: PER_PAGE,
        page,
      });
      changedFiles.push(...response.data.map((file) => file.filename));
      if (response.data.length < PER_PAGE) break;
    }

    return { diff: String(data), changedFiles };
  }

  async getExistingFingerprints(pr: PullRequestInfo): Promise<Set<string>> {
    const fingerprints = new Set<string>();
    const collect = (comments: { body?: string }[]): void => {
      for (const comment of comments) {
        for (const fp of extractFingerprints(comment.body ?? '')) fingerprints.add(fp);
      }
    };

    // Inline review comments and issue comments (the fallback path) can both
    // carry markers from previous runs.
    for (let page = 1; ; page += 1) {
      const response = await this.octokit.rest.pulls.listReviewComments({
        owner: this.owner,
        repo: this.repo,
        pull_number: Number(pr.id),
        per_page: PER_PAGE,
        page,
      });
      collect(response.data);
      if (response.data.length < PER_PAGE) break;
    }
    for (let page = 1; ; page += 1) {
      const response = await this.octokit.rest.issues.listComments({
        owner: this.owner,
        repo: this.repo,
        issue_number: Number(pr.id),
        per_page: PER_PAGE,
        page,
      });
      collect(response.data);
      if (response.data.length < PER_PAGE) break;
    }
    return fingerprints;
  }

  async postReview(pr: PullRequestInfo, review: ReviewToPost): Promise<void> {
    if (review.comments.length === 0) {
      if (review.summary.trim()) {
        await this.octokit.rest.issues.createComment({
          owner: this.owner,
          repo: this.repo,
          issue_number: Number(pr.id),
          body: review.summary,
        });
      }
      return;
    }

    try {
      // One review = one notification, with all findings anchored inline.
      await this.octokit.rest.pulls.createReview({
        owner: this.owner,
        repo: this.repo,
        pull_number: Number(pr.id),
        commit_id: pr.sourceCommit,
        event: 'COMMENT',
        body: review.summary,
        comments: review.comments.map((comment) => ({
          path: comment.file,
          line: comment.line,
          side: 'RIGHT' as const,
          body: comment.body,
        })),
      });
    } catch {
      // Line anchors the API rejects (422: line not part of the diff) sink the
      // whole review, so fall back to a single unanchored comment that keeps
      // every finding (and its fingerprint marker) visible.
      const body = [
        review.summary,
        ...review.comments.map((comment) => `---\n\`${comment.file}:${comment.line}\`\n\n${comment.body}`),
      ].join('\n\n');
      await this.octokit.rest.issues.createComment({
        owner: this.owner,
        repo: this.repo,
        issue_number: Number(pr.id),
        body,
      });
    }
  }
}
