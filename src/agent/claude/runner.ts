import { resolve, sep } from 'node:path';
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ReviewOutput, parseReviewOutput, reviewOutputJsonSchema, reviewOutputSchema } from '../../core/findings.js';
import { REVIEW_SYSTEM_PROMPT, WIKI_SYSTEM_PROMPT, buildReviewPrompt, buildWikiPrompt } from '../prompts.js';
import { AgentRunner, ReviewTask, WikiTask } from '../types.js';

export interface ClaudeRunnerOptions {
  model: string;
  /** Called with progress lines (tool activity) for verbose logging. */
  onProgress?: (line: string) => void;
}

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];

export class ClaudeAgentRunner implements AgentRunner {
  constructor(private readonly options: ClaudeRunnerOptions) {}

  async review(task: ReviewTask): Promise<ReviewOutput> {
    const result = await this.run(buildReviewPrompt(task), {
      cwd: task.repoPath,
      model: this.options.model,
      systemPrompt: REVIEW_SYSTEM_PROMPT,
      tools: READ_ONLY_TOOLS,
      allowedTools: READ_ONLY_TOOLS,
      maxTurns: task.maxTurns,
      outputFormat: { type: 'json_schema', schema: reviewOutputJsonSchema },
    });

    const structured = reviewOutputSchema.safeParse(result.structuredOutput);
    if (structured.success) return structured.data;
    return parseReviewOutput(result.text);
  }

  async generateWiki(task: WikiTask): Promise<void> {
    const knowledgeRoot = resolve(task.repoPath, task.knowledgePath) + sep;
    const writeTools = ['Write', 'Edit'];
    await this.run(buildWikiPrompt(task), {
      cwd: task.repoPath,
      model: this.options.model,
      systemPrompt: WIKI_SYSTEM_PROMPT,
      tools: [...READ_ONLY_TOOLS, ...writeTools],
      allowedTools: READ_ONLY_TOOLS,
      maxTurns: task.maxTurns,
      // Confine writes to the knowledge bundle; everything else is read-only.
      canUseTool: async (toolName, input) => {
        if (!writeTools.includes(toolName)) {
          return { behavior: 'allow', updatedInput: input };
        }
        const target = typeof input.file_path === 'string' ? resolve(input.file_path) : '';
        if (target.startsWith(knowledgeRoot)) {
          return { behavior: 'allow', updatedInput: input };
        }
        return {
          behavior: 'deny',
          message: `Writes are only allowed under ${task.knowledgePath}`,
        };
      },
    });
  }

  private async run(
    prompt: string,
    options: Options,
  ): Promise<{ text: string; structuredOutput: unknown }> {
    const stream = query({ prompt, options });
    let lastText = '';

    for await (const message of stream as AsyncIterable<SDKMessage>) {
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text.trim()) {
            lastText = block.text;
          } else if (block.type === 'tool_use') {
            this.options.onProgress?.(`[tool] ${block.name} ${summarizeInput(block.input)}`);
          }
        }
      } else if (message.type === 'result') {
        if (message.subtype !== 'success') {
          const detail = 'errors' in message ? message.errors.join('; ') : '';
          throw new Error(`Agent run failed (${message.subtype}) ${detail}`.trim());
        }
        return {
          text: message.result || lastText,
          structuredOutput: message.structured_output,
        };
      }
    }
    throw new Error('Agent stream ended without a result message');
  }
}

function summarizeInput(input: unknown): string {
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    const value = record.file_path ?? record.pattern ?? record.command ?? '';
    return typeof value === 'string' ? value : '';
  }
  return '';
}
