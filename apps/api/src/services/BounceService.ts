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
 * The strike history lives in `email.bounce` events. The webhook stores on each bounce
 * event the address that bounced (`recipient`), the SES bounce time (`bouncedAt`), the
 * SES `messageId`, the strike number (`relayStrike`) and whether that bounce unsubscribed
 * the contact (`unsubscribed`). Bounces recorded before those markers existed never
 * count as strikes.
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
  /** ISO 8601 time at which the ISP sent the bounce. */
  timestamp?: string;
}

export interface RelayStrikeVerdict {
  /** The relay address this strike belongs to (from the DSN, not the contact record). */
  recipient: string;
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
   * The address SES actually attempted, taken from the DSN. Falls back to the contact's
   * current address when the notification carries none. Using the DSN keeps a bounce
   * attached to the address that produced it even if the contact's email was changed
   * between sending and the bounce arriving.
   */
  public static bouncedAddress(bounce: SesBounce | undefined, fallback: string): string {
    const fromDsn = bounce?.bouncedRecipients?.find(
      recipient => typeof recipient.emailAddress === 'string' && recipient.emailAddress.includes('@'),
    )?.emailAddress;
    return (fromDsn ?? fallback).trim();
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
   * Decide how to treat a permanent bounce for a private-relay address.
   *
   * Returns `null` when the bounce is not a relay "user not found" bounce (callers fall
   * back to the normal hard-bounce handling). Otherwise returns the strike number:
   * one strike per distinct UTC day of the SES bounce time, bounded by
   * RELAY_STRIKE_WINDOW_DAYS, scoped to the bounced address and reset by a later
   * `contact.subscribed` event. Same-day repeats (e.g. several workflow emails during
   * one bad hour at Apple) never escalate, and a redelivered notification for the same
   * SES `messageId` never counts twice.
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
    const recipient = this.bouncedAddress(bounce, contact.email);
    if (!this.isPrivateRelayAddress(recipient) || !this.isUserNotFoundBounce(bounce)) {
      return null;
    }

    const windowStart = new Date(bouncedAt.getTime() - RELAY_STRIKE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    // Re-subscribing a contact (dashboard, API, or a manual recovery after a false bounce)
    // resets the count: strikes recorded before the latest `contact.subscribed` event are ignored.
    const resubscribed = await prisma.event.findFirst({
      where: {contactId: contact.id, name: 'contact.subscribed'},
      orderBy: {createdAt: 'desc'},
      select: {createdAt: true},
    });
    const countFrom = resubscribed && resubscribed.createdAt > windowStart ? resubscribed.createdAt : windowStart;

    // Distinct strike days are aggregated in the database (index [contactId, name, createdAt]),
    // grouped by the SES bounce time stored on the event (processing time for events that
    // predate that field), scoped to the bounced address and ignoring a redelivery of the
    // same SES message. The result is at most one row per day inside the window.
    const strikeDays = await prisma.$queryRaw<{day: string}[]>`
      SELECT DISTINCT to_char(
        (CASE WHEN data->>'bouncedAt' ~ '^\\d{4}-\\d{2}-\\d{2}T'
              THEN (data->>'bouncedAt')::timestamptz
              ELSE "createdAt" AT TIME ZONE 'UTC' END) AT TIME ZONE 'UTC',
        'YYYY-MM-DD'
      ) AS day
      FROM events
      WHERE "contactId" = ${contact.id}
        AND name = 'email.bounce'
        AND "createdAt" >= ${countFrom}
        AND jsonb_typeof(data->'relayStrike') = 'number'
        AND lower(data->>'recipient') = ${recipient.toLowerCase()}
        AND (${messageId ?? null}::text IS NULL OR data->>'messageId' IS DISTINCT FROM ${messageId ?? null}::text)
    `;

    const today = toUtcDay(bouncedAt);
    const priorStrikeDays = strikeDays.filter(row => row.day !== today).length;
    const strike = priorStrikeDays + 1;
    return {recipient, strike, threshold: RELAY_HARD_BOUNCE_STRIKES, unsubscribe: strike >= RELAY_HARD_BOUNCE_STRIKES};
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
    const causalBounce = await prisma.$queryRaw<{found: number}[]>`
      SELECT 1 AS found
      FROM events
      WHERE "contactId" = ${contact.id}
        AND name = 'email.bounce'
        AND "createdAt" > ${resubscribed?.createdAt ?? new Date(0)}
        AND (data->>'recipient' IS NULL OR lower(data->>'recipient') = ${contact.email.toLowerCase()})
        AND (CASE WHEN jsonb_typeof(data->'unsubscribed') = 'boolean'
                  THEN (data->>'unsubscribed')::boolean
                  ELSE data->>'bounceType' = 'Permanent' END)
      LIMIT 1
    `;
    return causalBounce.length > 0;
  }
}

function toUtcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
