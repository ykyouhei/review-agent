import {
  GetCommentsForPullRequestCommand,
  GetPullRequestCommand,
  PostCommentForPullRequestCommand,
} from '@aws-sdk/client-codecommit';
import { describe, expect, it } from 'vitest';
import { fingerprint, fingerprintMarker } from '../../core/findings.js';
import { PullRequestInfo } from '../types.js';
import { CodeCommitProvider } from './provider.js';

interface SentCommand {
  name: string;
  input: Record<string, unknown>;
}

function fakeClient(handlers: Record<string, (input: never) => unknown>) {
  const sent: SentCommand[] = [];
  return {
    sent,
    client: {
      send: (command: { constructor: { name: string }; input: unknown }) => {
        const name = command.constructor.name;
        sent.push({ name, input: command.input as Record<string, unknown> });
        const handler = handlers[name];
        if (!handler) throw new Error(`Unexpected command ${name}`);
        return Promise.resolve(handler(command.input as never));
      },
    },
  };
}

const pr: PullRequestInfo = {
  id: '12',
  title: 'feat',
  description: 'desc',
  repository: 'my-app',
  sourceCommit: 'src123',
  destinationCommit: 'dst456',
};

function provider(client: { send: (c: never) => Promise<unknown> }): CodeCommitProvider {
  return new CodeCommitProvider({
    repositoryName: 'my-app',
    repoPath: '/nonexistent',
    client: client as never,
  });
}

describe('CodeCommitProvider', () => {
  it('maps GetPullRequest onto PullRequestInfo, picking the matching target', async () => {
    const { client } = fakeClient({
      [GetPullRequestCommand.name]: () => ({
        pullRequest: {
          title: 'feat: add x',
          description: 'why',
          pullRequestTargets: [
            { repositoryName: 'other', sourceCommit: 'a', destinationCommit: 'b' },
            {
              repositoryName: 'my-app',
              sourceCommit: 'src123',
              destinationCommit: 'dst456',
              mergeBase: 'mb789',
            },
          ],
        },
      }),
    });
    const info = await provider(client).getPullRequest('12');
    expect(info).toMatchObject({
      id: '12',
      title: 'feat: add x',
      repository: 'my-app',
      sourceCommit: 'src123',
      destinationCommit: 'dst456',
      mergeBase: 'mb789',
    });
  });

  it('collects fingerprints from paginated PR comments', async () => {
    const marked = fingerprintMarker({ file: 'src/a.ts', category: 'bug', title: 'Old finding' });
    let calls = 0;
    const { client } = fakeClient({
      [GetCommentsForPullRequestCommand.name]: () => {
        calls += 1;
        return calls === 1
          ? {
              commentsForPullRequestData: [
                { comments: [{ content: `text ${marked}` }, { content: 'human comment' }] },
              ],
              nextToken: 'page2',
            }
          : { commentsForPullRequestData: [{ comments: [{ content: 'no marker' }] }] };
      },
    });
    const fingerprints = await provider(client).getExistingFingerprints(pr);
    expect(calls).toBe(2);
    expect(fingerprints).toEqual(
      new Set([fingerprint({ file: 'src/a.ts', category: 'bug', title: 'Old finding' })]),
    );
  });

  it('posts a summary and line-anchored comments with commit ids', async () => {
    const { client, sent } = fakeClient({
      [PostCommentForPullRequestCommand.name]: () => ({}),
    });
    await provider(client).postReview(pr, {
      summary: 'overall summary',
      comments: [{ file: 'src/a.ts', line: 10, body: 'inline body' }],
    });

    expect(sent).toHaveLength(2);
    expect(sent[0]?.input).toMatchObject({
      pullRequestId: '12',
      repositoryName: 'my-app',
      beforeCommitId: 'dst456',
      afterCommitId: 'src123',
      content: 'overall summary',
    });
    expect(sent[1]?.input).toMatchObject({
      content: 'inline body',
      location: { filePath: 'src/a.ts', filePosition: 10, relativeFileVersion: 'AFTER' },
    });
  });

  it('falls back to an unanchored comment when the anchored post is rejected', async () => {
    const { client, sent } = fakeClient({
      [PostCommentForPullRequestCommand.name]: (input: { location?: unknown }) => {
        if (input.location) throw new Error('InvalidFileLocationException');
        return {};
      },
    });
    await provider(client).postReview(pr, {
      summary: '',
      comments: [{ file: 'src/a.ts', line: 999, body: 'drifted' }],
    });
    const unanchored = sent.filter((s) => !('location' in s.input && s.input.location));
    expect(unanchored).toHaveLength(1);
    expect(unanchored[0]?.input.content).toContain('src/a.ts:999');
    expect(unanchored[0]?.input.content).toContain('drifted');
  });
});
