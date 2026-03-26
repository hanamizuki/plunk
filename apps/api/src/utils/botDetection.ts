// Known bot/proxy userAgent patterns that produce fake Open/Click events.
// Yahoo, Barracuda, and Outlook preload tracking pixels and links
// within seconds of delivery, inflating open/click counts with non-human activity.
// NOTE: Apple MPP is detected via bare "Mozilla/5.0" UA (see isMachineOpen).
// Microsoft SafeLinks cannot be detected by UA alone — it requires IP-range
// or timing-based heuristics (out of scope here).
//
// GoogleImageProxy is intentionally NOT included here. Gmail routes ALL tracking
// pixel requests through its image proxy — including legitimate user opens.
// Filtering it would discard every Gmail open event and severely undercount engagement.
const BOT_UA_PATTERNS: RegExp[] = [
  /YahooMailProxy/i,
  /Barracuda Sentinel/i,
];

// Outlook mobile preloading: both markers must be present.
// Desktop Outlook contains only "Microsoft Office" — those opens are legitimate
// (user is reading the email), so we intentionally require the mobile marker too.
const OUTLOOK_IOS_ANDROID = /Outlook-iOS-Android/i;
const MICROSOFT_OFFICE = /Microsoft Office/i;

/**
 * Returns true if the userAgent belongs to a known email-client bot/proxy.
 * Empty string is intentionally NOT treated as bot — caller handles the warning.
 */
export function isBotUserAgent(ua: string): boolean {
  if (!ua) return false;
  if (BOT_UA_PATTERNS.some(p => p.test(ua))) return true;
  if (OUTLOOK_IOS_ANDROID.test(ua) && MICROSOFT_OFFICE.test(ua)) return true;
  return false;
}

/**
 * Returns true if the userAgent matches a known machine-open pattern.
 * Machine opens are automated prefetches by email clients (e.g. Apple MPP).
 * Unlike bots, machine opens are recorded for transparency but excluded from metrics.
 *
 * Apple Mail Privacy Protection (iOS 15+/macOS 12+) prefetches all tracking pixels
 * on delivery. Its UA is a bare "Mozilla/5.0" with no OS or browser details —
 * real browsers always include parenthesized platform info after "Mozilla/5.0".
 */
export function isMachineOpen(ua: string): boolean {
  if (!ua) return false;
  return ua.trim() === 'Mozilla/5.0';
}

/**
 * Coerce unknown userAgent value to string.
 * SES webhook payloads are untyped JSON — guard against non-string values.
 */
export function normalizeUserAgent(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Mask email for logging to avoid PII exposure.
 * "alice@example.com" → "a***@e***.com"
 */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at < 1) return '***';
  const [local, domain] = [email.slice(0, at), email.slice(at + 1)];
  const dot = domain.lastIndexOf('.');
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${local[0]}***@${domain[0]}***${tld}`;
}

/**
 * Strip control characters (newlines, tabs, etc.) to prevent log injection.
 */
export function sanitizeForLog(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1f\x7f]/g, '');
}
