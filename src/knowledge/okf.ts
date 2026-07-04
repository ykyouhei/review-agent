import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import matter from 'gray-matter';

/**
 * Minimal Open Knowledge Format (OKF) support: markdown files with YAML
 * frontmatter, organized in a directory bundle, plus a generated index.
 * https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf
 */

export type OkfEntryType = 'wiki' | 'guideline' | 'review-note' | 'index' | string;

export interface OkfFrontmatter {
  type: OkfEntryType;
  title: string;
  tags?: string[];
  timestamp?: string;
  [key: string]: unknown;
}

export interface OkfEntry {
  /** Path relative to the bundle root. */
  path: string;
  frontmatter: OkfFrontmatter;
  body: string;
}

export function readEntry(bundleRoot: string, relPath: string): OkfEntry {
  const parsed = matter(readFileSync(join(bundleRoot, relPath), 'utf8'));
  const data = parsed.data as Partial<OkfFrontmatter>;
  return {
    path: relPath,
    frontmatter: {
      type: data.type ?? 'wiki',
      title: data.title ?? relPath,
      ...data,
    },
    body: parsed.content.trim(),
  };
}

export function writeEntry(bundleRoot: string, entry: OkfEntry): void {
  const file = join(bundleRoot, entry.path);
  const serialized = matter.stringify(`\n${entry.body.trim()}\n`, {
    ...entry.frontmatter,
    timestamp: entry.frontmatter.timestamp ?? new Date().toISOString(),
  });
  writeFileSync(file, serialized);
}

export function listEntries(bundleRoot: string): OkfEntry[] {
  const entries: OkfEntry[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (name.endsWith('.md')) {
        const rel = relative(bundleRoot, full);
        if (rel === 'index.md') continue;
        entries.push(readEntry(bundleRoot, rel));
      }
    }
  };
  walk(bundleRoot);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Generate index.md: a compact, links-only table of contents. This is the only
 * knowledge file injected into the review prompt — the agent reads linked
 * entries on demand, so prompt size stays flat as knowledge grows.
 */
export function generateIndex(bundleRoot: string): string {
  const entries = listEntries(bundleRoot);
  const byType = new Map<string, OkfEntry[]>();
  for (const entry of entries) {
    const list = byType.get(entry.frontmatter.type) ?? [];
    list.push(entry);
    byType.set(entry.frontmatter.type, list);
  }

  const sections = [...byType.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, list]) => {
      const items = list
        .map((entry) => {
          const tags = entry.frontmatter.tags?.length
            ? ` — ${entry.frontmatter.tags.join(', ')}`
            : '';
          return `- [${entry.frontmatter.title}](${entry.path})${tags}`;
        })
        .join('\n');
      return `## ${type}\n\n${items}`;
    });

  const body = sections.length > 0 ? sections.join('\n\n') : '_No knowledge entries yet._';
  const index = matter.stringify(`\n${body}\n`, {
    type: 'index',
    title: 'Knowledge Index',
    timestamp: new Date().toISOString(),
  });
  writeFileSync(join(bundleRoot, 'index.md'), index);
  return index;
}
