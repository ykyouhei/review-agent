import { resolve, sep } from 'node:path';
import {
  CopilotClient,
  type PermissionHandler,
  type SessionConfig,
} from '@github/copilot-sdk';
import { ReviewOutput, parseReviewOutput } from '../../core/findings.js';
import { REVIEW_SYSTEM_PROMPT, WIKI_SYSTEM_PROMPT, buildReviewPrompt, buildWikiPrompt } from '../prompts.js';
import { AgentRunner, ReviewTask, WikiTask } from '../types.js';

export interface CopilotRunnerOptions {
  model: string;
  /** Called with progress lines (tool activity) for verbose logging. */
  onProgress?: (line: string) => void;
  /** Injectable for tests. */
  createClient?: (workingDirectory: string) => Pick<CopilotClient, 'createSession' | 'stop'>;
}

/** Generous per-message timeout: agentic reviews explore the repository. */
const SEND_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * GitHub Copilot SDK backend. The SDK bundles the Copilot CLI and talks to it
 * over JSON-RPC, mirroring the Claude Agent SDK's shape. Auth rides
 * COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN or an existing CLI login and
 * requires a Copilot subscription.
 *
 * The Copilot SDK has no json_schema output mode, so the prompt requests a
 * JSON fence and the shared parseReviewOutput() parser extracts the findings.
 */
export class CopilotAgentRunner implements AgentRunner {
  constructor(private readonly options: CopilotRunnerOptions) {}

  async review(task: ReviewTask): Promise<ReviewOutput> {
    const text = await this.run(task.repoPath, buildReviewPrompt(task, { jsonInText: true }), {
      systemMessage: { mode: 'append', content: REVIEW_SYSTEM_PROMPT },
      onPermissionRequest: readOnlyPermissions,
    });
    return parseReviewOutput(text);
  }

  async generateWiki(task: WikiTask): Promise<void> {
    const knowledgeRoot = resolve(task.repoPath, task.knowledgePath) + sep;
    await this.run(task.repoPath, buildWikiPrompt(task), {
      systemMessage: { mode: 'append', content: WIKI_SYSTEM_PROMPT },
      onPermissionRequest: knowledgeOnlyWritePermissions(task.repoPath, knowledgeRoot),
    });
  }

  private async run(
    repoPath: string,
    prompt: string,
    config: Pick<SessionConfig, 'systemMessage' | 'onPermissionRequest'>,
  ): Promise<string> {
    const client =
      this.options.createClient?.(repoPath) ?? new CopilotClient({ workingDirectory: repoPath });

    // Session-level failures (auth, provider errors) surface as session.error
    // events or as floating promise rejections inside the SDK rather than as a
    // sendAndWait rejection — capture both and race them against the response.
    let rejectOnSessionError: (error: Error) => void = () => {};
    const sessionError = new Promise<never>((_, reject) => {
      rejectOnSessionError = (error) => reject(error);
    });
    const onUnhandledRejection = (reason: unknown): void => {
      rejectOnSessionError(reason instanceof Error ? reason : new Error(String(reason)));
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const session = await client.createSession({
        model: this.options.model,
        workingDirectory: repoPath,
        ...config,
      });
      session.on((event) => {
        if (event.type === 'tool.execution_start') {
          this.options.onProgress?.(`[tool] ${event.data.toolName}`);
        } else if (event.type === 'session.error') {
          rejectOnSessionError(new Error(event.data.message));
        }
      });
      const response = await Promise.race([
        session.sendAndWait({ prompt }, SEND_TIMEOUT_MS),
        sessionError,
      ]);
      const text = response?.data.content ?? '';
      if (!text.trim()) {
        throw new Error('Copilot agent returned an empty response');
      }
      return text;
    } catch (error) {
      throw decorateAuthError(error);
    } finally {
      await client.stop().catch(() => {});
      // Node emits unhandledRejection after the current microtask drain, so
      // removing the listener synchronously here would reopen the crash
      // window — defer past one macrotask.
      await new Promise((resolveTick) => setImmediate(resolveTick));
      process.removeListener('unhandledRejection', onUnhandledRejection);
    }
  }
}

/**
 * Review mode: deny-by-default. Reads are allowed; shell, writes, MCP, URLs
 * and anything unknown are rejected — the reviewer only needs to look.
 */
export const readOnlyPermissions: PermissionHandler = (request) => {
  if (request.kind === 'read') {
    return { kind: 'approve-once' };
  }
  return { kind: 'reject', feedback: 'This review session is read-only.' };
};

/** Wiki mode: reads allowed, writes only inside the knowledge bundle. */
export function knowledgeOnlyWritePermissions(
  repoPath: string,
  knowledgeRoot: string,
): PermissionHandler {
  return (request) => {
    if (request.kind === 'read') {
      return { kind: 'approve-once' };
    }
    if (request.kind === 'write') {
      const target = resolve(repoPath, request.fileName);
      if (target.startsWith(knowledgeRoot)) {
        return { kind: 'approve-once' };
      }
      return { kind: 'reject', feedback: `Writes are only allowed under ${knowledgeRoot}` };
    }
    return { kind: 'reject', feedback: 'Only file reads and knowledge writes are allowed.' };
  };
}

function decorateAuthError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/auth|login|unauthorized|401|subscription|token/i.test(message)) {
    return new Error(
      `Copilot agent run failed: ${message}. Set COPILOT_GITHUB_TOKEN (or GH_TOKEN) for an account with a Copilot subscription.`,
    );
  }
  return error instanceof Error ? error : new Error(message);
}
