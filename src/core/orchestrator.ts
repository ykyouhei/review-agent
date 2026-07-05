import { AgentRunner, ReviewTask } from '../agent/types.js';
import { Config } from '../config/index.js';
import { KnowledgeStore } from '../knowledge/store.js';
import { DiffResult, InlineComment, VcsProvider } from '../vcs/types.js';
import { FilterResult, filterFindings } from './filter.js';
import { Finding, ReviewOutput, fingerprintMarker } from './findings.js';

export interface ReviewSubject {
  title: string;
  description: string;
  diff: DiffResult;
  existingFingerprints: Set<string>;
}

export interface ReviewRunResult {
  output: ReviewOutput;
  filter: FilterResult;
  posted: boolean;
}

export interface OrchestratorDeps {
  repoPath: string;
  config: Config;
  runner: AgentRunner;
  log?: (line: string) => void;
}

export async function reviewPullRequest(
  deps: OrchestratorDeps,
  provider: VcsProvider,
  pullRequestId: string,
  options: { dryRun: boolean },
): Promise<ReviewRunResult> {
  const log = deps.log ?? (() => {});
  log(`Fetching pull request ${pullRequestId}...`);
  const pr = await provider.getPullRequest(pullRequestId);
  const diff = await provider.getDiff(pr);
  const existingFingerprints = await provider.getExistingFingerprints(pr);

  const result = await runReview(deps, {
    title: pr.title,
    description: pr.description,
    diff,
    existingFingerprints,
  });

  if (!options.dryRun && (result.filter.kept.length > 0 || result.output.summary.trim())) {
    log('Posting review...');
    await provider.postReview(pr, {
      summary: formatSummary(result, deps.config),
      comments: result.filter.kept.map(toInlineComment),
    });
    result.posted = true;
  }
  return result;
}

export async function reviewLocal(
  deps: OrchestratorDeps,
  subject: { base: string; diff: DiffResult },
): Promise<ReviewRunResult> {
  return runReview(deps, {
    title: `Local changes against ${subject.base}`,
    description: 'Review of the local working tree (uncommitted changes included).',
    diff: subject.diff,
    existingFingerprints: new Set(),
  });
}

async function runReview(deps: OrchestratorDeps, subject: ReviewSubject): Promise<ReviewRunResult> {
  const log = deps.log ?? (() => {});
  if (!subject.diff.diff.trim()) {
    throw new Error('The diff is empty — nothing to review.');
  }

  const store = new KnowledgeStore(deps.repoPath, deps.config.knowledge.path);
  const knowledgeIndex = store.readIndex();
  if (knowledgeIndex) log(`Using knowledge bundle at ${deps.config.knowledge.path}`);

  const task: ReviewTask = {
    repoPath: deps.repoPath,
    title: subject.title,
    description: subject.description,
    diff: subject.diff.diff,
    changedFiles: subject.diff.changedFiles,
    knowledgeIndex,
    knowledgePath: deps.config.knowledge.path,
    guidelines: deps.config.review.guidelines,
    language: deps.config.language,
    maxTurns: deps.config.review.maxTurns,
  };

  log(`Reviewing ${subject.diff.changedFiles.length} changed file(s) with ${deps.config.agent} agent...`);
  const output = await deps.runner.review(task);
  log(`Agent returned ${output.findings.length} finding(s).`);

  const filter = filterFindings(output.findings, {
    minSeverity: deps.config.review.minSeverity,
    minConfidence: deps.config.review.minConfidence,
    maxComments: deps.config.review.maxComments,
    ignore: deps.config.review.ignore,
    existingFingerprints: subject.existingFingerprints,
    changedFiles: subject.diff.changedFiles,
  });
  if (filter.dropped.length > 0) {
    log(`Filtered out ${filter.dropped.length} finding(s): ${summarizeDrops(filter)}`);
  }

  return { output, filter, posted: false };
}

function toInlineComment(finding: Finding): InlineComment {
  const severityLabel = `**[${finding.severity}]**`;
  const suggestion = finding.suggestion
    ? `\n\n\`\`\`suggestion\n${finding.suggestion}\n\`\`\``
    : '';
  return {
    file: finding.file,
    line: finding.startLine,
    body: `${severityLabel} ${finding.title}\n\n${finding.body}${suggestion}\n\n${fingerprintMarker(finding)}`,
  };
}

function formatSummary(result: ReviewRunResult, config: Config): string {
  const counts = new Map<string, number>();
  for (const finding of result.filter.kept) {
    counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  }
  const countLine =
    result.filter.kept.length > 0
      ? [...counts.entries()].map(([severity, n]) => `${severity}: ${n}`).join(', ')
      : 'no findings above thresholds';
  return [
    `## 🤖 review-agent`,
    '',
    result.output.summary,
    '',
    `_${countLine} (agent: ${config.agent}, model: ${config.model})_`,
  ].join('\n');
}

function summarizeDrops(filter: FilterResult): string {
  const byReason = new Map<string, number>();
  for (const drop of filter.dropped) {
    byReason.set(drop.reason, (byReason.get(drop.reason) ?? 0) + 1);
  }
  return [...byReason.entries()].map(([reason, n]) => `${reason}=${n}`).join(', ');
}
