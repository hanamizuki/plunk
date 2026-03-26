import {describe, expect, it} from 'vitest';

import {isBotUserAgent, isMachineOpen, maskEmail, normalizeUserAgent, sanitizeForLog} from '../botDetection';

describe('isBotUserAgent', () => {
  // GoogleImageProxy is NOT a bot — Gmail routes all tracking pixels through it,
  // including legitimate user opens. Filtering it would drop all Gmail engagement.
  it('allows GoogleImageProxy (Gmail image proxy is not a bot)', () => {
    expect(isBotUserAgent('GoogleImageProxy')).toBe(false);
  });

  it('allows GoogleImageProxy in full UA string', () => {
    expect(isBotUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) GoogleImageProxy')).toBe(false);
  });

  // Yahoo mail proxy
  it('detects YahooMailProxy', () => {
    expect(isBotUserAgent('YahooMailProxy/1.0')).toBe(true);
  });

  // Barracuda Sentinel (enterprise email security scanner)
  it('detects Barracuda Sentinel', () => {
    expect(isBotUserAgent('Barracuda Sentinel (EE)')).toBe(true);
  });

  // Outlook preloading — requires BOTH markers
  it('detects Outlook preloading with both markers', () => {
    expect(isBotUserAgent('Mozilla/5.0 Outlook-iOS-Android/1.0 Microsoft Office/16.0')).toBe(true);
  });

  it('does not flag Outlook-iOS-Android alone', () => {
    expect(isBotUserAgent('Outlook-iOS-Android/1.0')).toBe(false);
  });

  it('does not flag Microsoft Office alone', () => {
    expect(isBotUserAgent('Microsoft Office/16.0')).toBe(false);
  });

  // Non-bot user agents
  it('allows normal browser UA', () => {
    expect(isBotUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')).toBe(false);
  });

  it('allows mobile browser UA', () => {
    expect(isBotUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe(false);
  });

  // Empty string — not treated as bot (caller logs warning)
  it('returns false for empty string', () => {
    expect(isBotUserAgent('')).toBe(false);
  });
});

describe('isMachineOpen', () => {
  // Apple MPP uses bare "Mozilla/5.0" with no OS/browser details
  it('detects bare Mozilla/5.0 as machine open', () => {
    expect(isMachineOpen('Mozilla/5.0')).toBe(true);
  });

  it('detects Mozilla/5.0 with trailing whitespace', () => {
    expect(isMachineOpen('Mozilla/5.0 ')).toBe(true);
  });

  // Full browser UA strings contain more than just "Mozilla/5.0"
  it('allows full browser UA containing Mozilla/5.0', () => {
    expect(isMachineOpen('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')).toBe(false);
  });

  it('allows iPhone Safari UA', () => {
    expect(isMachineOpen('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isMachineOpen('')).toBe(false);
  });

  it('returns false for GoogleImageProxy', () => {
    expect(isMachineOpen('Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)')).toBe(false);
  });
});

describe('normalizeUserAgent', () => {
  it('passes through a string', () => {
    expect(normalizeUserAgent('Mozilla/5.0')).toBe('Mozilla/5.0');
  });

  it('returns empty string for undefined', () => {
    expect(normalizeUserAgent(undefined)).toBe('');
  });

  it('returns empty string for number', () => {
    expect(normalizeUserAgent(42)).toBe('');
  });

  it('returns empty string for object', () => {
    expect(normalizeUserAgent({foo: 'bar'})).toBe('');
  });
});

describe('maskEmail', () => {
  it('masks local and domain parts', () => {
    expect(maskEmail('alice@example.com')).toBe('a***@e***.com');
  });

  it('handles single-char local part', () => {
    expect(maskEmail('a@b.co')).toBe('a***@b***.co');
  });

  it('returns *** for invalid email', () => {
    expect(maskEmail('no-at-sign')).toBe('***');
  });
});

describe('sanitizeForLog', () => {
  it('strips newlines and tabs', () => {
    expect(sanitizeForLog('line1\nline2\ttab')).toBe('line1line2tab');
  });

  it('strips null bytes', () => {
    expect(sanitizeForLog('hello\x00world')).toBe('helloworld');
  });

  it('preserves normal text', () => {
    expect(sanitizeForLog('Mozilla/5.0 (X11; Linux x86_64)')).toBe('Mozilla/5.0 (X11; Linux x86_64)');
  });
});
