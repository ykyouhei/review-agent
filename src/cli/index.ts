#!/usr/bin/env node
import { Command } from 'commander';
import { createAgentRunner } from '../agent/index.js';
import { loadConfig } from '../config/index.js';
import { ReviewRunResult, reviewLocal, reviewPullRequest } from '../core/orchestrator.js';
import { KnowledgeStore } from '../knowledge/store.js';
import { detectCiContext } from '../vcs/detect.js';
import { diffLocal } from '../vcs/git.js';
import { createVcsProvider } from '../vcs/index.js';

const program = new Command();

program
  .name('review-agent')
  .description('CI-agnostic, agentic pull request reviewer with repository-wide context')
  .option('-C, --cwd <path>', 'repository path', process.cwd())
  .option('-v, --verbose', 'log agent tool activity', false);

interface GlobalOptions {
  cwd: string;
  verbose: boolean;
}

program
  .command('review')
  .description('Review a pull request (or the local diff with --local)')
  .option('--pr <id>', 'pull request id (auto-detected from CI env when omitted)')
  .option('--repo <name>', 'repository name (auto-detected from CI env when omitted)')
  .option('--region <region>', 'AWS region for CodeCommit')
  .option('--local', 'review the local working tree instead of a pull request', false)
  .option('--base <ref>', 'base ref for --local mode', 'main')
  .option('--dry-run', 'print findings instead of posting them', false)
  .action(async (options: {
    pr?: string;
    repo?: string;
    region?: string;
    local: boolean;
    base: string;
    dryRun: boolean;
  }) => {
    const globals = program.opts<GlobalOptions>();
    const repoPath = globals.cwd;
    const config = loadConfig(repoPath);
    const log = (line: string) => console.error(line);
    const runner = createAgentRunner(config, globals.verbose ? log : undefined);
    const deps = { repoPath, config, runner, log };

    let result: ReviewRunResult;
    if (options.local) {
      result = await reviewLocal(deps, {
        base: options.base,
        diff: diffLocal(repoPath, options.base),
      });
    } else {
      const detected = detectCiContext();
      const pullRequestId = options.pr ?? detected.pullRequestId;
      if (!pullRequestId) {
        throw new Error(
          'Could not determine the pull request id. Pass --pr or set REVIEW_AGENT_PR.' +
            (detected.source ? ` (detected CI: ${detected.source})` : ''),
        );
      }
      const provider = createVcsProvider(config, {
        repoPath,
        repository: options.repo ?? detected.repository,
        region: options.region ?? detected.region,
      });
      result = await reviewPullRequest(deps, provider, pullRequestId, {
        dryRun: options.dryRun,
      });
    }

    render(result, options.dryRun || options.local);
  });

const knowledge = program
  .command('knowledge')
  .description('Manage the OKF knowledge bundle used during reviews');

knowledge
  .command('init')
  .description('Scaffold the knowledge bundle (index, wiki/, guidelines/, review-notes/)')
  .action(() => {
    const globals = program.opts<GlobalOptions>();
    const config = loadConfig(globals.cwd);
    const store = new KnowledgeStore(globals.cwd, config.knowledge.path);
    store.init();
    console.log(`Initialized knowledge bundle at ${config.knowledge.path}`);
  });

knowledge
  .command('wiki')
  .description('Explore the repository with the agent and generate/update wiki entries')
  .action(async () => {
    const globals = program.opts<GlobalOptions>();
    const config = loadConfig(globals.cwd);
    const log = (line: string) => console.error(line);
    const store = new KnowledgeStore(globals.cwd, config.knowledge.path);
    if (!store.exists()) store.init();

    const runner = createAgentRunner(config, globals.verbose ? log : undefined);
    log('Generating repository wiki (this explores the whole repository)...');
    await runner.generateWiki({
      repoPath: globals.cwd,
      knowledgePath: config.knowledge.path,
      language: config.language,
      maxTurns: config.review.maxTurns,
    });
    store.refreshIndex();
    console.log(`Wiki updated under ${config.knowledge.path}/wiki (index regenerated).`);
  });

function render(result: ReviewRunResult, toStdout: boolean): void {
  if (result.posted) {
    console.log(`Posted ${result.filter.kept.length} comment(s) + summary.`);
    return;
  }
  if (!toStdout) return;

  console.log('\n===== Review summary =====\n');
  console.log(result.output.summary || '(no summary)');
  console.log(`\n===== Findings (${result.filter.kept.length}) =====`);
  for (const finding of result.filter.kept) {
    console.log(
      `\n[${finding.severity}] ${finding.file}:${finding.startLine}${
        finding.endLine !== finding.startLine ? `-${finding.endLine}` : ''
      } (${finding.category}, confidence ${finding.confidence.toFixed(2)})`,
    );
    console.log(`  ${finding.title}`);
    console.log(indent(finding.body, 2));
    if (finding.suggestion) {
      console.log('  suggestion:');
      console.log(indent(finding.suggestion, 4));
    }
  }
  if (result.filter.dropped.length > 0) {
    console.log(`\n(${result.filter.dropped.length} finding(s) filtered out)`);
  }
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => pad + line)
    .join('\n');
}

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
