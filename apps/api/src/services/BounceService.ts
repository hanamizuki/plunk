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

import signale from 'signale';

import {RELAY_HARD_BOUNCE_STRIKES} from '../app/constants.js';
import {prisma} from '../database/prisma.js';
import {redis} from '../database/redis.js';

/**
 * Domains used by Apple's private email relay. Apple announced on 2026-08-24 that newly
 * issued relay addresses move to `private.icloud.com`; existing
 * `privaterelay.appleid.com` addresses keep working.
 */
export const PRIVATE_RELAY_DOMAINS: readonly string[] = ['privaterelay.appleid.com', 'private.icloud.com'];

/** Only relay bounces inside this window count as strikes. */
export const RELAY_STRIKE_WINDOW_DAYS = 90;

/** How long a per-address strike lock may be held (a webhook call takes well under a second). */
const STRIKE_LOCK_TTL_MS = 10_000;
/** How long a webhook call waits for the lock before proceeding without it. */
const STRIKE_LOCK_WAIT_MS = 5_000;

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
    // same SES message. The window / reset cutoff is applied to that same bounce time, so
    // a notification that SNS delivers late is still attributed to when Apple bounced it,
    // and only strikes up to this bounce's own time count — a delayed old notification
    // must not borrow strikes that happened after it. At most one row per day.
    const strikeDays = await prisma.$queryRaw<{day: string}[]>`
      WITH bounces AS (
        SELECT (CASE WHEN data->>'bouncedAt' ~ '^\\d{4}-\\d{2}-\\d{2}T'
                     THEN (data->>'bouncedAt')::timestamptz
                     ELSE "createdAt" AT TIME ZONE 'UTC' END) AS bounced_at
        FROM events
        WHERE "contactId" = ${contact.id}
          AND name = 'email.bounce'
          AND "createdAt" >= ${windowStart}
          AND jsonb_typeof(data->'relayStrike') = 'number'
          AND lower(data->>'recipient') = ${recipient.toLowerCase()}
          AND (${messageId ?? null}::text IS NULL OR data->>'messageId' IS DISTINCT FROM ${messageId ?? null}::text)
      )
      SELECT DISTINCT to_char(bounced_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day
      FROM bounces
      WHERE bounced_at >= ${countFrom}
        AND bounced_at <= ${bouncedAt}
    `;

    // A bounce that Apple reported before the contact was last re-subscribed (or outside the
    // window) is stale evidence and must not add a strike, however late SNS delivers it.
    const counts = bouncedAt >= countFrom;
    const today = toUtcDay(bouncedAt);
    const priorStrikeDays = strikeDays.filter(row => row.day !== today).length;
    const strike = priorStrikeDays + (counts ? 1 : 0);
    return {
      recipient,
      strike,
      threshold: RELAY_HARD_BOUNCE_STRIKES,
      unsubscribe: counts && strike >= RELAY_HARD_BOUNCE_STRIKES,
    };
  }

  /**
   * Run `fn` while holding a short lock on the bounced address. SNS can deliver several
   * bounce notifications for one address concurrently; without serialization each of them
   * would read the same strike history, all stay below the threshold and the contact would
   * only be unsubscribed by a later bounce. The lock spans evaluating the strike and
   * recording its event.
   *
   * Fail-open: when the lock cannot be obtained within STRIKE_LOCK_WAIT_MS, or Redis is
   * unavailable, the work runs anyway — a strike counted late is better than a bounce that
   * is never recorded (the webhook acknowledges the SNS message either way).
   */
  public static async withRelayStrikeLock<T>(recipient: string, fn: () => Promise<T>): Promise<T> {
    const key = `bounce:relay-strike-lock:${recipient.trim().toLowerCase()}`;
    const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const deadline = Date.now() + STRIKE_LOCK_WAIT_MS;

    let acquired = false;
    try {
      while (Date.now() < deadline) {
        if ((await redis.set(key, token, 'PX', STRIKE_LOCK_TTL_MS, 'NX')) === 'OK') {
          acquired = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 50 + Math.floor(Math.random() * 50)));
      }
      if (!acquired) {
        signale.warn(`[BOUNCE] Relay strike lock not acquired within ${STRIKE_LOCK_WAIT_MS}ms, proceeding without it`);
      }
    } catch (error) {
      signale.warn('[BOUNCE] Relay strike lock unavailable (Redis error), proceeding without it:', error);
      acquired = false;
    }

    if (!acquired) {
      return fn();
    }

    try {
      return await fn();
    } finally {
      // Release only if the lock is still ours (it may have expired and been re-acquired).
      // A failed release is harmless: the key expires on its own after STRIKE_LOCK_TTL_MS.
      try {
        await redis.eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          1,
          key,
          token,
        );
      } catch (error) {
        signale.warn('[BOUNCE] Failed to release relay strike lock (it expires on its own):', error);
      }
    }
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
    // Same effective bounce time as the strike query: a bounce Apple reported before the
    // contact was last re-subscribed does not count, however late SNS delivered it.
    const causalBounce = await prisma.$queryRaw<{found: number}[]>`
      SELECT 1 AS found
      FROM events
      WHERE "contactId" = ${contact.id}
        AND name = 'email.bounce'
        AND (CASE WHEN data->>'bouncedAt' ~ '^\\d{4}-\\d{2}-\\d{2}T'
                  THEN (data->>'bouncedAt')::timestamptz
                  ELSE "createdAt" AT TIME ZONE 'UTC' END) > ${resubscribed?.createdAt ?? new Date(0)}
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
