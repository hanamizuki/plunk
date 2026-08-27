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

/** Upper bound on bounce events read per strike evaluation (newest first). */
export const RELAY_STRIKE_EVENT_LIMIT = 100;

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
    const domain = email
      .slice(at + 1)
      .trim()
      .toLowerCase();
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
        (recipient.status ?? '').trim() === '5.1.1' ||
        /(^|[^\d.])5\.1\.1([^\d.]|$)/.test(recipient.diagnosticCode ?? ''),
    );
  }

  /**
   * Decide how to treat a permanent bounce for a private-relay contact.
   *
   * Returns `null` when the bounce is not a relay "user not found" bounce (callers fall
   * back to the normal hard-bounce handling). Otherwise returns the strike number:
   * one strike per distinct UTC day, bounded by RELAY_STRIKE_WINDOW_DAYS and reset by a
   * later `contact.subscribed` event. Same-day repeats (e.g. several workflow emails
   * during one bad hour at Apple) never escalate, and a redelivered notification for the
   * same SES `messageId` never counts twice.
   *
   * @param bouncedAt When the bounce happened (the SES bounce timestamp); decides the strike day.
   * @param messageId SES message id of the bounced email, used to ignore SNS redeliveries.
   */
  public static async evaluateRelayStrike(
    contact: {id: string; email: string},
    bounce: SesBounce | undefined,
    bouncedAt: Date = new Date(),
    messageId?: string | null,
  ): Promise<RelayStrikeVerdict | null> {
    if (!this.isPrivateRelayAddress(contact.email) || !this.isUserNotFoundBounce(bounce)) {
      return null;
    }

    const now = bouncedAt;
    const windowStart = new Date(now.getTime() - RELAY_STRIKE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    // Re-subscribing a contact (dashboard, API, or a manual recovery after a false bounce)
    // resets the count: strikes recorded before the latest `contact.subscribed` event are ignored.
    const resubscribed = await prisma.event.findFirst({
      where: {contactId: contact.id, name: 'contact.subscribed'},
      orderBy: {createdAt: 'desc'},
      select: {createdAt: true},
    });
    const countFrom = resubscribed && resubscribed.createdAt > windowStart ? resubscribed.createdAt : windowStart;

    // Indexed by [contactId, name, createdAt]. A contact only ever has a handful of these,
    // but the read is bounded anyway: the newest RELAY_STRIKE_EVENT_LIMIT bounces are more
    // than enough to reach any sane threshold, so the webhook cost cannot grow with history.
    const priorBounces = await prisma.event.findMany({
      where: {contactId: contact.id, name: 'email.bounce', createdAt: {gte: countFrom}},
      select: {createdAt: true, data: true},
      orderBy: {createdAt: 'desc'},
      take: RELAY_STRIKE_EVENT_LIMIT,
    });

    const today = toUtcDay(now);
    const priorStrikeDays = new Set<string>();
    for (const event of priorBounces) {
      const data = event.data as {relayStrike?: unknown; recipient?: unknown; messageId?: unknown} | null;
      if (typeof data?.relayStrike !== 'number') {
        continue; // bounce recorded before strike tracking (or not a relay bounce) — never counts
      }
      if (data.recipient !== contact.email) {
        continue; // strikes belong to the address that bounced, not to the (mutable) contact
      }
      if (messageId && data.messageId === messageId) {
        continue; // SNS redelivered the same bounce notification — not a new strike
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
   *
   * Only bounces that actually unsubscribed the contact count (`data.unsubscribed` is
   * `true`, which the webhook also sets for unknown bounce types it treats as permanent).
   * A tolerated relay strike records `unsubscribed: false` and is ignored, so a contact
   * that was already unsubscribed for another reason can still reach the strike threshold
   * — or recover. Bounces recorded for a previous address of the contact, or before the
   * contact was last re-subscribed, are ignored too. Events written before those markers
   * existed always unsubscribed on a permanent bounce, so a missing marker falls back to
   * `bounceType === 'Permanent'`.
   */
  public static async isHardBounced(contact: {id: string; email: string; subscribed: boolean}): Promise<boolean> {
    if (contact.subscribed) {
      return false;
    }
    const resubscribed = await prisma.event.findFirst({
      where: {contactId: contact.id, name: 'contact.subscribed'},
      orderBy: {createdAt: 'desc'},
      select: {createdAt: true},
    });
    const bounces = await prisma.event.findMany({
      where: {
        contactId: contact.id,
        name: 'email.bounce',
        ...(resubscribed ? {createdAt: {gt: resubscribed.createdAt}} : {}),
      },
      select: {data: true},
      orderBy: {createdAt: 'desc'},
      take: RELAY_STRIKE_EVENT_LIMIT,
    });
    return bounces.some(event => {
      const data = event.data as {unsubscribed?: unknown; bounceType?: unknown; recipient?: unknown} | null;
      if (typeof data?.recipient === 'string' && data.recipient !== contact.email) {
        return false; // the bounce belonged to an address this contact no longer uses
      }
      if (typeof data?.unsubscribed === 'boolean') {
        return data.unsubscribed;
      }
      return data?.bounceType === 'Permanent';
    });
  }
}

function toUtcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
