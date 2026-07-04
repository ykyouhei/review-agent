import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { severities } from '../core/findings.js';

export const CONFIG_FILENAMES = ['.review-agent.yml', '.review-agent.yaml'];

export const configSchema = z.object({
  agent: z.enum(['claude', 'copilot']).default('claude'),
  vcs: z.enum(['codecommit', 'github', 'gitlab']).default('codecommit'),
  model: z.string().default('claude-sonnet-5'),
  /** Language for review comments (e.g. "ja", "en"). */
  language: z.string().default('ja'),
  review: z
    .object({
      maxComments: z.number().int().min(1).default(10),
      minSeverity: z.enum(severities).default('minor'),
      minConfidence: z.number().min(0).max(1).default(0.7),
      ignore: z.array(z.string()).default([]),
      /** Extra review instructions appended to the prompt. */
      guidelines: z.string().optional(),
      maxTurns: z.number().int().min(1).default(80),
    })
    .default({}),
  knowledge: z
    .object({
      path: z.string().default('.review-agent/knowledge'),
    })
    .default({}),
  codecommit: z
    .object({
      repositoryName: z.string().optional(),
      region: z.string().optional(),
    })
    .default({}),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(repoPath: string): Config {
  for (const filename of CONFIG_FILENAMES) {
    const file = join(repoPath, filename);
    if (!existsSync(file)) continue;
    const raw: unknown = parseYaml(readFileSync(file, 'utf8')) ?? {};
    const result = configSchema.safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
        .join('\n');
      throw new Error(`Invalid ${filename}:\n${issues}`);
    }
    return result.data;
  }
  return configSchema.parse({});
}
