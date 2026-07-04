import { ReviewOutput } from '../core/findings.js';

export interface ReviewTask {
  /** Absolute path of the repository the agent may explore (read-only). */
  repoPath: string;
  title: string;
  description: string;
  /** Unified diff of the change under review. */
  diff: string;
  changedFiles: string[];
  /** Contents of the knowledge bundle's index.md, if the bundle exists. */
  knowledgeIndex?: string;
  /** Repo-relative path of the knowledge bundle (for on-demand reads). */
  knowledgePath?: string;
  /** Extra review instructions from config. */
  guidelines?: string;
  /** Language for the summary and comments (e.g. "ja"). */
  language: string;
  maxTurns: number;
}

export interface WikiTask {
  repoPath: string;
  /** Repo-relative path of the knowledge bundle to write into. */
  knowledgePath: string;
  language: string;
  maxTurns: number;
}

/**
 * Task-level abstraction over agent SDKs (Claude Agent SDK, Copilot SDK, ...).
 * The agentic loop — tool use, repository exploration — is the SDK's job;
 * implementations only translate task in / structured findings out.
 */
export interface AgentRunner {
  review(task: ReviewTask): Promise<ReviewOutput>;
  generateWiki(task: WikiTask): Promise<void>;
}
