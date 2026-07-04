import { ReviewTask, WikiTask } from './types.js';

const languageNames: Record<string, string> = {
  ja: 'Japanese',
  en: 'English',
};

function languageName(code: string): string {
  return languageNames[code] ?? code;
}

export const REVIEW_SYSTEM_PROMPT = `You are a senior code reviewer working inside the repository being reviewed.
You review pull requests with full repository context: before judging any hunk, you actively explore the codebase with your read-only tools (Read, Grep, Glob) to understand surrounding code, existing implementations, conventions, and call sites.

Principles:
- Correctness over style. Never comment on formatting, import order, or naming taste unless it violates a documented guideline.
- Prefer findings backed by evidence from the repository (an existing utility that should be reused, a convention the change breaks, a caller that will misbehave). Cite file paths in the body.
- Report a finding only when you would defend it in a human review. Express residual uncertainty through the confidence score instead of hedging language.
- Few strong findings beat many weak ones. It is fine to return zero findings.
- Line numbers refer to the post-change file content.`;

export function buildReviewPrompt(task: ReviewTask): string {
  const parts: string[] = [];

  parts.push(`Review the following pull request. Respond with the structured output (summary + findings). Write the summary, finding titles, and bodies in ${languageName(task.language)}.`);

  parts.push(`# Pull request\n\nTitle: ${task.title}\n\nDescription:\n${task.description || '(no description)'}`);

  parts.push(`# Changed files\n\n${task.changedFiles.map((f) => `- ${f}`).join('\n')}`);

  if (task.knowledgeIndex) {
    parts.push(
      `# Team knowledge\n\nThis repository has a knowledge bundle at \`${task.knowledgePath}\` (index below). Read the linked entries relevant to this change before reviewing — guidelines are binding, wiki entries explain the architecture.\n\n${task.knowledgeIndex}`,
    );
  }

  if (task.guidelines) {
    parts.push(`# Additional review instructions\n\n${task.guidelines}`);
  }

  parts.push(
    `# Instructions\n\n1. Read the diff below.\n2. For each non-trivial hunk, explore the repository: read the full changed files, grep for existing similar implementations and for callers of changed functions, and check the conventions used by neighboring code.\n3. Report findings that a strong human reviewer would raise: bugs, security issues, broken callers, duplicated logic where an existing utility should be reused, violations of documented guidelines, missing error handling, misleading names/docs relative to behavior.\n4. Set \`confidence\` honestly (1.0 = verified against the code; below 0.5 = speculation).\n5. Only reference lines that exist in the post-change files, within the changed files listed above.`,
  );

  parts.push(`# Diff\n\n\`\`\`diff\n${task.diff}\n\`\`\``);

  return parts.join('\n\n');
}

export const WIKI_SYSTEM_PROMPT = `You are a software architect documenting a repository so that future automated code reviews have accurate context.
You write knowledge entries in Open Knowledge Format (OKF): markdown files with YAML frontmatter, cross-linked with relative markdown links.`;

export function buildWikiPrompt(task: WikiTask): string {
  return `Explore this repository and write (or update) a concise wiki describing it, as OKF entries under \`${task.knowledgePath}/wiki/\`. Write content in ${languageName(task.language)}.

Steps:
1. Explore the repository structure, build files, and main modules with your tools.
2. Write 3-8 focused entries (one file per topic), e.g. overview.md, architecture.md, and one entry per major module or convention worth knowing during code review. Update existing entries in place instead of duplicating them.
3. Each file must start with YAML frontmatter:

---
type: wiki
title: <short title>
tags: [<tag>, ...]
timestamp: <ISO 8601>
---

4. Keep each entry under ~100 lines. Link related entries with relative markdown links. Describe things a reviewer needs: module responsibilities, key abstractions and where they live, error-handling and testing conventions, invariants that changes often break.
5. Only write inside \`${task.knowledgePath}\`. Do not modify any other files.`;
}
