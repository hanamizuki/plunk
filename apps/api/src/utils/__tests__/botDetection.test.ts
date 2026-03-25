import {describe, expect, it} from 'vitest';

import {isBotUserAgent} from '../botDetection';

describe('isBotUserAgent', () => {
  // Gmail image proxy
  it('detects GoogleImageProxy', () => {
    expect(isBotUserAgent('GoogleImageProxy')).toBe(true);
  });

  it('detects GoogleImageProxy in full UA string', () => {
    expect(isBotUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) GoogleImageProxy')).toBe(true);
  });

  it('detects GoogleImageProxy case-insensitively', () => {
    expect(isBotUserAgent('googleimageproxy')).toBe(true);
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
