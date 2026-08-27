/**
 * BounceService — bounce classification shared by the SES webhook and the email worker.
 *
 * Why this exists: Apple's "Hide My Email" relay (Sign in with Apple) intermittently
 * answers `550 5.1.1 <addr>: user not found` for addresses that are perfectly valid —
 * the same address flips between 250 and 550 on the same relay MX within seconds.
 * SES reports that as a Permanent/General bounce, so treating every hard bounce as
 * final silently unsubscribes real users. For relay domains we count hard
 * "user not found" bounces on distinct days and only unsubscribe at a threshold.
 *
 * The strike history lives in `email.bounce` events (`data.relayStrike`), so bounces
 * recorded before strike tracking existed never count.
 */

import {RELAY_HARD_BOUNCE_STRIKES} from '../app/constants.js';
import {prisma} from '../database/prisma.js';

/**
 * Domains used by Apple's private email relay. Apple announced on 2026-08-24 that newly
 * issued relay addresses move to `private.icloud.com`; existing
 * `privaterelay.appleid.com` addresses keep working.
 */
export const PRIVATE_RELAY_DOMAINS: readonly string[] = ['privaterelay.appleid.com', 'private.icloud.com'];

/** Only relay bounces inside this window count as strikes. */
export const RELAY_STRIKE_WINDOW_DAYS = 90;

/** The subset of the SES `bounce` notification object we rely on. */
export interface SesBouncedRecipient {
  emailAddress?: string;
  action?: string;
  /** DSN status, e.g. "5.1.1" */
  status?: string;
  /** Reporting MTA response, e.g. "smtp; 550 5.1.1 <addr>: user not found" */
  diagnosticCode?: string;
}

export interface SesBounce {
  bounceType?: string;
  bounceSubType?: string;
  bouncedRecipients?: SesBouncedRecipient[];
}

export interface RelayStrikeVerdict {
  /** 1-based strike number for this bounce (distinct UTC days inside the window). */
  strike: number;
  threshold: number;
  /** True when this bounce reaches the threshold and the contact must be unsubscribed. */
  unsubscribe: boolean;
}

export class BounceService {
  /**
   * Whether an address belongs to Apple's private email relay (case-insensitive exact domain match).
   */
  public static isPrivateRelayAddress(email: string): boolean {
    const at = email.lastIndexOf('@');
    if (at < 0) {
      return false;
    }
    const domain = email.slice(at + 1).trim().toLowerCase();
    return PRIVATE_RELAY_DOMAINS.includes(domain);
  }

  /**
   * A permanent bounce whose DSN status is 5.1.1 ("bad destination mailbox address").
   * The status field can be absent from the DSN, so the diagnostic code is checked as well.
   */
  public static isUserNotFoundBounce(bounce: SesBounce | undefined): boolean {
    if (bounce?.bounceType !== 'Permanent') {
      return false;
    }
    return (bounce.bouncedRecipients ?? []).some(
      recipient =>
        (recipient.status ?? '').startsWith('5.1.1') || /(^|[^\d.])5\.1\.1([^\d.]|$)/.test(recipient.diagnosticCode ?? ''),
    );
  }

  /**
   * Decide how to treat a permanent bounce for a private-relay contact.
   *
   * Returns `null` when the bounce is not a relay "user not found" bounce (callers fall
   * back to the normal hard-bounce handling). Otherwise returns the strike number:
   * one strike per distinct UTC day, bounded by RELAY_STRIKE_WINDOW_DAYS. Same-day
   * repeats (e.g. several workflow emails during one bad hour at Apple) never escalate.
   */
  public static async evaluateRelayStrike(
    contact: {id: string; email: string},
    bounce: SesBounce | undefined,
    now: Date = new Date(),
  ): Promise<RelayStrikeVerdict | null> {
    if (!this.isPrivateRelayAddress(contact.email) || !this.isUserNotFoundBounce(bounce)) {
      return null;
    }

    const windowStart = new Date(now.getTime() - RELAY_STRIKE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    // Indexed by [contactId, name, createdAt]; a contact only ever has a handful of these.
    const priorBounces = await prisma.event.findMany({
      where: {contactId: contact.id, name: 'email.bounce', createdAt: {gte: windowStart}},
      select: {createdAt: true, data: true},
    });

    const today = toUtcDay(now);
    const priorStrikeDays = new Set<string>();
    for (const event of priorBounces) {
      const data = event.data as {relayStrike?: unknown} | null;
      if (typeof data?.relayStrike !== 'number') {
        continue; // bounce recorded before strike tracking (or not a relay bounce) — never counts
      }
      const day = toUtcDay(event.createdAt);
      if (day !== today) {
        priorStrikeDays.add(day);
      }
    }

    const strike = priorStrikeDays.size + 1;
    return {strike, threshold: RELAY_HARD_BOUNCE_STRIKES, unsubscribe: strike >= RELAY_HARD_BOUNCE_STRIKES};
  }

  /**
   * True when the contact was unsubscribed by a hard bounce. Such addresses must not be
   * handed to SES again — every attempt is a guaranteed bounce that only hurts sender
   * reputation. Contacts that unsubscribed manually (no hard bounce on record) are not
   * affected, and neither are contacts that were re-subscribed after a bounce.
   */
  public static async isHardBounced(contact: {id: string; subscribed: boolean}): Promise<boolean> {
    if (contact.subscribed) {
      return false;
    }
    const hardBounce = await prisma.event.findFirst({
      where: {contactId: contact.id, name: 'email.bounce', data: {path: ['bounceType'], equals: 'Permanent'}},
      select: {id: true},
    });
    return hardBounce !== null;
  }
}

function toUtcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
