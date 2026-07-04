import { describe, expect, it } from 'vitest';
import { filterFindings } from './filter.js';
import { Finding, fingerprint } from './findings.js';

function finding(overrides: Partial<Finding>): Finding {
  return {
    file: 'src/a.ts',
    startLine: 1,
    endLine: 1,
    severity: 'major',
    category: 'bug',
    title: 'title',
    body: 'body',
    confidence: 0.9,
    ...overrides,
  };
}

const baseOptions = {
  minSeverity: 'minor' as const,
  minConfidence: 0.7,
  maxComments: 10,
  ignore: [],
  existingFingerprints: new Set<string>(),
};

describe('filterFindings', () => {
  it('drops findings below severity and confidence thresholds', () => {
    const result = filterFindings(
      [finding({ severity: 'info', title: 'a' }), finding({ confidence: 0.5, title: 'b' })],
      baseOptions,
    );
    expect(result.kept).toHaveLength(0);
    expect(result.dropped.map((d) => d.reason).sort()).toEqual([
      'below-min-confidence',
      'below-min-severity',
    ]);
  });

  it('drops ignored paths and files outside the diff', () => {
    const result = filterFindings(
      [
        finding({ file: 'package-lock.json', title: 'a' }),
        finding({ file: 'src/other.ts', title: 'b' }),
      ],
      { ...baseOptions, ignore: ['**/*.json'], changedFiles: ['src/a.ts'] },
    );
    expect(result.kept).toHaveLength(0);
    expect(result.dropped.map((d) => d.reason).sort()).toEqual(['ignored-path', 'outside-diff']);
  });

  it('dedupes against previous runs and within the same run', () => {
    const f = finding({ title: 'dup' });
    const previous = filterFindings([f], {
      ...baseOptions,
      existingFingerprints: new Set([fingerprint(f)]),
    });
    expect(previous.dropped[0]?.reason).toBe('duplicate');

    const sameRun = filterFindings([f, finding({ title: 'dup!' })], baseOptions);
    expect(sameRun.kept).toHaveLength(1);
    expect(sameRun.dropped[0]?.reason).toBe('duplicate');
  });

  it('caps comments ordered by severity then confidence', () => {
    const result = filterFindings(
      [
        finding({ severity: 'minor', title: 'low' }),
        finding({ severity: 'critical', title: 'top', confidence: 0.8 }),
        finding({ severity: 'critical', title: 'top2', confidence: 0.95 }),
      ],
      { ...baseOptions, maxComments: 2 },
    );
    expect(result.kept.map((f) => f.title)).toEqual(['top2', 'top']);
    expect(result.dropped[0]?.reason).toBe('over-max-comments');
  });
});
