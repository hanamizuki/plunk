// Known bot/proxy userAgent patterns that produce fake Open/Click events.
// Gmail, Yahoo, and Outlook preload tracking pixels and links within seconds
// of delivery, inflating open/click counts with non-human activity.
const BOT_UA_PATTERNS: RegExp[] = [/GoogleImageProxy/i, /YahooMailProxy/i];

/**
 * Returns true if the userAgent belongs to a known email-client bot/proxy.
 * Empty string is intentionally NOT treated as bot — caller handles the warning.
 */
export function isBotUserAgent(ua: string): boolean {
  if (!ua) return false;
  if (BOT_UA_PATTERNS.some(p => p.test(ua))) return true;
  // Outlook preloading: both markers must be present
  if (/Outlook-iOS-Android/i.test(ua) && /Microsoft Office/i.test(ua)) return true;
  return false;
}
