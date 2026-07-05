import type { PermissionRequest, SessionConfig, SessionEvent } from '@github/copilot-sdk';
import { describe, expect, it } from 'vitest';
import { ReviewTask, WikiTask } from '../types.js';
import { CopilotAgentRunner, knowledgeOnlyWritePermissions, readOnlyPermissions } from './runner.js';

const reviewTask: ReviewTask = {
  repoPath: '/repo',
  title: 'feat: add x',
  description: 'why',
  diff: 'diff --git a/src/a.ts b/src/a.ts\n+const x = 1;\n',
  changedFiles: ['src/a.ts'],
  language: 'ja',
  maxTurns: 80,
};

const wikiTask: WikiTask = {
  repoPath: '/repo',
  knowledgePath: '.review-agent/knowledge',
  language: 'ja',
  maxTurns: 80,
};

const validOutput = {
  summary: 'summary',
  findings: [
    {
      file: 'src/a.ts',
      startLine: 1,
      endLine: 1,
      severity: 'major',
      category: 'bug',
      title: 't',
      body: 'b',
      confidence: 0.9,
    },
  ],
};

interface FakeCalls {
  workingDirectory?: string;
  config?: SessionConfig;
  prompt?: string;
  stopped: boolean;
}

function fakeClientFactory(responseText: string | Error) {
  const calls: FakeCalls = { stopped: false };
  const createClient = (workingDirectory: string) => {
    calls.workingDirectory = workingDirectory;
    return {
      createSession: (config: SessionConfig) => {
        calls.config = config;
        return Promise.resolve({
          on: (_handler: (event: SessionEvent) => void) => () => {},
          sendAndWait: (options: { prompt: string }) => {
            calls.prompt = options.prompt;
            if (responseText instanceof Error) return Promise.reject(responseText);
            return Promise.resolve({ data: { content: responseText } });
          },
        });
      },
      stop: () => {
        calls.stopped = true;
        return Promise.resolve([]);
      },
    } as never;
  };
  return { calls, createClient };
}

function runner(factory: ReturnType<typeof fakeClientFactory>): CopilotAgentRunner {
  return new CopilotAgentRunner({ model: 'gpt-5', createClient: factory.createClient });
}

describe('CopilotAgentRunner.review', () => {
  it('sends a JSON-instruction prompt and parses the fenced output', async () => {
    const factory = fakeClientFactory(
      `Here is my review.\n\`\`\`json\n${JSON.stringify(validOutput)}\n\`\`\``,
    );
    const output = await runner(factory).review(reviewTask);

    expect(output.findings).toHaveLength(1);
    expect(output.summary).toBe('summary');
    expect(factory.calls.workingDirectory).toBe('/repo');
    expect(factory.calls.config?.model).toBe('gpt-5');
    expect(factory.calls.prompt).toContain('```json');
    expect(factory.calls.prompt).toContain('const x = 1;');
    expect(factory.calls.stopped).toBe(true);
  });

  it('stops the client even when the session fails, and decorates auth errors', async () => {
    const factory = fakeClientFactory(new Error('401 unauthorized'));
    await expect(runner(factory).review(reviewTask)).rejects.toThrow(/COPILOT_GITHUB_TOKEN/);
    expect(factory.calls.stopped).toBe(true);
  });

  it('rejects an empty response', async () => {
    const factory = fakeClientFactory('   ');
    await expect(runner(factory).review(reviewTask)).rejects.toThrow(/empty response/);
  });
});

describe('permission handlers', () => {
  const invocation = { sessionId: 's' };
  const read = { kind: 'read', path: '/repo/src/a.ts', intention: 'look' } as PermissionRequest;
  const shell = { kind: 'shell' } as unknown as PermissionRequest;
  const write = (fileName: string): PermissionRequest =>
    ({ kind: 'write', fileName, diff: '', intention: '', canOfferSessionApproval: false }) as PermissionRequest;

  it('review mode allows reads only', () => {
    expect(readOnlyPermissions(read, invocation)).toEqual({ kind: 'approve-once' });
    expect(readOnlyPermissions(shell, invocation)).toMatchObject({ kind: 'reject' });
    expect(readOnlyPermissions(write('/repo/src/a.ts'), invocation)).toMatchObject({
      kind: 'reject',
    });
  });

  it('wiki mode allows writes only inside the knowledge bundle', () => {
    const handler = knowledgeOnlyWritePermissions('/repo', '/repo/.review-agent/knowledge/');
    expect(handler(read, invocation)).toEqual({ kind: 'approve-once' });
    expect(handler(write('/repo/.review-agent/knowledge/wiki/a.md'), invocation)).toEqual({
      kind: 'approve-once',
    });
    // Relative paths resolve against the repo root.
    expect(handler(write('.review-agent/knowledge/wiki/b.md'), invocation)).toEqual({
      kind: 'approve-once',
    });
    expect(handler(write('/repo/src/a.ts'), invocation)).toMatchObject({ kind: 'reject' });
    expect(handler(write('/elsewhere/x.md'), invocation)).toMatchObject({ kind: 'reject' });
    expect(handler(shell, invocation)).toMatchObject({ kind: 'reject' });
  });
});

describe('CopilotAgentRunner.generateWiki', () => {
  it('runs with the knowledge-scoped permission handler', async () => {
    const factory = fakeClientFactory('done');
    await runner(factory).generateWiki(wikiTask);

    const handler = factory.calls.config?.onPermissionRequest;
    expect(handler).toBeDefined();
    const write = {
      kind: 'write',
      fileName: '/repo/.review-agent/knowledge/wiki/x.md',
      diff: '',
      intention: '',
      canOfferSessionApproval: false,
    } as PermissionRequest;
    expect(await handler!(write, { sessionId: 's' })).toEqual({ kind: 'approve-once' });
    const outside = { ...write, fileName: '/repo/README.md' } as PermissionRequest;
    expect(await handler!(outside, { sessionId: 's' })).toMatchObject({ kind: 'reject' });
  });
});
