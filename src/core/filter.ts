import picomatch from 'picomatch';
import { Finding, Severity, fingerprint, severityRank } from './findings.js';

export interface FilterOptions {
  minSeverity: Severity;
  minConfidence: number;
  maxComments: number;
  ignore: string[];
  /** Fingerprints of comments this tool already posted on the PR. */
  existingFingerprints: Set<string>;
  /** When set, findings outside these files are dropped (agents sometimes drift). */
  changedFiles?: string[];
}

export type DropReason =
  | 'below-min-severity'
  | 'below-min-confidence'
  | 'ignored-path'
  | 'duplicate'
  | 'outside-diff'
  | 'over-max-comments';

export interface FilterResult {
  kept: Finding[];
  dropped: { finding: Finding; reason: DropReason }[];
}

/**
 * Noise-control pipeline: thresholds, path ignores, dedupe against previous
 * runs, and a hard cap ordered by severity then confidence.
 */
export function filterFindings(findings: Finding[], options: FilterOptions): FilterResult {
  const dropped: FilterResult['dropped'] = [];
  const isIgnored = options.ignore.length > 0 ? picomatch(options.ignore) : () => false;
  const changed = options.changedFiles ? new Set(options.changedFiles) : undefined;
  const seen = new Set(options.existingFingerprints);

  const candidates: Finding[] = [];
  for (const finding of findings) {
    if (severityRank[finding.severity] < severityRank[options.minSeverity]) {
      dropped.push({ finding, reason: 'below-min-severity' });
      continue;
    }
    if (finding.confidence < options.minConfidence) {
      dropped.push({ finding, reason: 'below-min-confidence' });
      continue;
    }
    if (isIgnored(finding.file)) {
      dropped.push({ finding, reason: 'ignored-path' });
      continue;
    }
    if (changed && !changed.has(finding.file)) {
      dropped.push({ finding, reason: 'outside-diff' });
      continue;
    }
    const fp = fingerprint(finding);
    if (seen.has(fp)) {
      dropped.push({ finding, reason: 'duplicate' });
      continue;
    }
    seen.add(fp);
    candidates.push(finding);
  }

  candidates.sort(
    (a, b) =>
      severityRank[b.severity] - severityRank[a.severity] || b.confidence - a.confidence,
  );

  const kept = candidates.slice(0, options.maxComments);
  for (const finding of candidates.slice(options.maxComments)) {
    dropped.push({ finding, reason: 'over-max-comments' });
  }
  return { kept, dropped };
}
