import { describe, it, expect } from 'vitest';
import { extractFindings } from './ralphUtils.js';

describe('extractFindings', () => {
  it('extracts bullet points from a well-formed KEY FINDINGS section', () => {
    const output = `Here is my analysis of the data.

## KEY FINDINGS
- The API rate limit is 100 requests per minute
- OAuth2 with PKCE is required for authentication
- Token endpoint is at /api/v2/auth/token

## Summary
This concludes my research.`;

    const findings = extractFindings(output);
    expect(findings).toEqual([
      'The API rate limit is 100 requests per minute',
      'OAuth2 with PKCE is required for authentication',
      'Token endpoint is at /api/v2/auth/token',
    ]);
  });

  it('returns empty array when no findings section present', () => {
    const output = 'Just a regular response with no findings section.';
    expect(extractFindings(output)).toEqual([]);
  });

  it('returns empty array for empty/null input', () => {
    expect(extractFindings('')).toEqual([]);
  });

  it('handles findings at end of output with no trailing section', () => {
    const output = `Some analysis here.

## KEY FINDINGS
- Finding at the very end
- Another final finding`;

    const findings = extractFindings(output);
    expect(findings).toEqual([
      'Finding at the very end',
      'Another final finding',
    ]);
  });

  it('handles * bullets as well as - bullets', () => {
    const output = `## KEY FINDINGS
* Star bullet one
* Star bullet two
- Dash bullet three`;

    const findings = extractFindings(output);
    expect(findings).toEqual([
      'Star bullet one',
      'Star bullet two',
      'Dash bullet three',
    ]);
  });

  it('filters out empty lines', () => {
    const output = `## KEY FINDINGS
- First finding

- Second finding

- Third finding`;

    const findings = extractFindings(output);
    expect(findings).toEqual([
      'First finding',
      'Second finding',
      'Third finding',
    ]);
  });

  it('caps findings at 15 per extraction', () => {
    const bullets = Array.from({ length: 20 }, (_, i) => `- Finding number ${i + 1}`).join('\n');
    const output = `## KEY FINDINGS\n${bullets}`;

    const findings = extractFindings(output);
    expect(findings).toHaveLength(15);
    expect(findings[0]).toBe('Finding number 1');
    expect(findings[14]).toBe('Finding number 15');
  });

  it('filters out overly long findings (>500 chars)', () => {
    const longFinding = 'x'.repeat(501);
    const output = `## KEY FINDINGS
- Short finding
- ${longFinding}
- Another short finding`;

    const findings = extractFindings(output);
    expect(findings).toEqual([
      'Short finding',
      'Another short finding',
    ]);
  });

  it('stops at the next ## heading', () => {
    const output = `## KEY FINDINGS
- Finding before heading

## Another Section
- This should not be extracted`;

    const findings = extractFindings(output);
    expect(findings).toEqual(['Finding before heading']);
  });

  it('handles case-insensitive header', () => {
    const output = `## key findings
- Case insensitive finding`;

    const findings = extractFindings(output);
    expect(findings).toEqual(['Case insensitive finding']);
  });

  it('strips leading whitespace from bullets', () => {
    const output = `## KEY FINDINGS
  - Indented finding
    * Deeply indented finding`;

    const findings = extractFindings(output);
    expect(findings).toEqual([
      'Indented finding',
      'Deeply indented finding',
    ]);
  });
});
