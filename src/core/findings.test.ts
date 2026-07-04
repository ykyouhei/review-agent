import { describe, expect, it } from 'vitest';
import {
  extractFingerprints,
  fingerprint,
  fingerprintMarker,
  parseReviewOutput,
} from './findings.js';

const base = {
  file: 'src/a.ts',
  startLine: 3,
  endLine: 5,
  severity: 'major' as const,
  category: 'bug',
  title: 'Null check missing',
  body: 'x may be undefined',
  confidence: 0.9,
};

describe('fingerprint', () => {
  it('is stable across line drift and punctuation changes', () => {
    const a = fingerprint({ file: 'src/a.ts', category: 'bug', title: 'Null check missing' });
    const b = fingerprint({ file: 'src/a.ts', category: 'Bug', title: 'null-check   missing!' });
    expect(a).toBe(b);
  });

  it('differs across files and categories', () => {
    const a = fingerprint({ file: 'src/a.ts', category: 'bug', title: 't' });
    expect(a).not.toBe(fingerprint({ file: 'src/b.ts', category: 'bug', title: 't' }));
    expect(a).not.toBe(fingerprint({ file: 'src/a.ts', category: 'security', title: 't' }));
  });

  it('round-trips through the comment marker', () => {
    const marker = fingerprintMarker(base);
    expect(extractFingerprints(`**[major]** text\n\n${marker}`)).toEqual([fingerprint(base)]);
  });
});

describe('parseReviewOutput', () => {
  const output = { summary: 'ok', findings: [base] };

  it('parses raw JSON', () => {
    expect(parseReviewOutput(JSON.stringify(output)).findings).toHaveLength(1);
  });

  it('parses a json fence with surrounding prose', () => {
    const text = `Here you go:\n\`\`\`json\n${JSON.stringify(output)}\n\`\`\`\nDone.`;
    expect(parseReviewOutput(text).summary).toBe('ok');
  });

  it('parses a <findings> wrapper containing a bare array', () => {
    const text = `<findings>${JSON.stringify([base])}</findings>`;
    expect(parseReviewOutput(text).findings[0]?.file).toBe('src/a.ts');
  });

  it('rejects invalid payloads', () => {
    expect(() => parseReviewOutput('no json here')).toThrow();
    expect(() => parseReviewOutput('{"summary":1}')).toThrow();
  });
});
