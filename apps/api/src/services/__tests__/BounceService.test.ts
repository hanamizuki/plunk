import {beforeEach, describe, expect, it} from 'vitest';
import {RELAY_HARD_BOUNCE_STRIKES} from '../../app/constants';
import {BounceService, RELAY_STRIKE_WINDOW_DAYS, type SesBounce} from '../BounceService';
import {factories, getPrismaClient} from '../../../../../test/helpers';

const DAY_MS = 24 * 60 * 60 * 1000;

/** SES bounce object as produced by Apple's relay for a (possibly false) "user not found". */
function userNotFound(email: string, overrides: Partial<SesBounce> = {}): SesBounce {
  return {
    bounceType: 'Permanent',
    bounceSubType: 'General',
    bouncedRecipients: [
      {
        emailAddress: email,
        action: 'failed',
        status: '5.1.1',
        diagnosticCode: `smtp; 550 5.1.1 <${email}>: user not found`,
      },
    ],
    ...overrides,
  };
}

describe('BounceService', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
  });

  /** Records an `email.bounce` event the way the webhook does (recipient = the contact's address unless overridden). */
  async function bounceEvent(contact: {id: string; email: string}, createdAt: Date, data: Record<string, unknown>) {
    return prisma.event.create({
      data: {
        projectId,
        contactId: contact.id,
        name: 'email.bounce',
        data: {recipient: contact.email, ...data},
        createdAt,
      },
    });
  }

  describe('isPrivateRelayAddress', () => {
    it('matches both Apple relay domains case-insensitively', () => {
      expect(BounceService.isPrivateRelayAddress('abc123@privaterelay.appleid.com')).toBe(true);
      expect(BounceService.isPrivateRelayAddress('Abc123@PrivateRelay.AppleID.com')).toBe(true);
      expect(BounceService.isPrivateRelayAddress('abc123@private.icloud.com')).toBe(true);
    });

    it('rejects consumer iCloud addresses and look-alike domains', () => {
      expect(BounceService.isPrivateRelayAddress('someone@icloud.com')).toBe(false);
      expect(BounceService.isPrivateRelayAddress('someone@private.icloud.com.example.com')).toBe(false);
      expect(BounceService.isPrivateRelayAddress('someone@notprivaterelay.appleid.com')).toBe(false);
      expect(BounceService.isPrivateRelayAddress('not-an-email')).toBe(false);
    });
  });

  describe('isUserNotFoundBounce', () => {
    it('accepts a permanent bounce with DSN status 5.1.1', () => {
      expect(BounceService.isUserNotFoundBounce(userNotFound('a@privaterelay.appleid.com'))).toBe(true);
    });

    it('falls back to the diagnostic code when the DSN status is missing', () => {
      const bounce: SesBounce = {
        bounceType: 'Permanent',
        bouncedRecipients: [
          {emailAddress: 'a@privaterelay.appleid.com', diagnosticCode: 'smtp; 550 5.1.1 user not found'},
        ],
      };
      expect(BounceService.isUserNotFoundBounce(bounce)).toBe(true);
    });

    it('rejects other permanent codes, transient bounces and missing data', () => {
      const policy: SesBounce = {
        bounceType: 'Permanent',
        bouncedRecipients: [{status: '5.7.1', diagnosticCode: 'smtp; 554 5.7.1 message rejected due to local policy'}],
      };
      expect(BounceService.isUserNotFoundBounce(policy)).toBe(false);
      expect(BounceService.isUserNotFoundBounce(userNotFound('a@x.com', {bounceType: 'Transient'}))).toBe(false);
      expect(BounceService.isUserNotFoundBounce({bounceType: 'Permanent'})).toBe(false);
      expect(BounceService.isUserNotFoundBounce(undefined)).toBe(false);
    });
  });

  describe('evaluateRelayStrike', () => {
    it('returns null for non-relay addresses and for non-5.1.1 relay bounces', async () => {
      const gmail = await factories.createContact({projectId, email: 'someone@gmail.com'});
      expect(await BounceService.evaluateRelayStrike(gmail, userNotFound(gmail.email))).toBeNull();

      const relay = await factories.createContact({projectId, email: 'abc123@privaterelay.appleid.com'});
      const policy: SesBounce = {bounceType: 'Permanent', bouncedRecipients: [{status: '5.7.1'}]};
      expect(await BounceService.evaluateRelayStrike(relay, policy)).toBeNull();
    });

    it('does not unsubscribe on the first strike', async () => {
      const relay = await factories.createContact({projectId, email: 'abc123@privaterelay.appleid.com'});

      const verdict = await BounceService.evaluateRelayStrike(relay, userNotFound(relay.email));

      expect(verdict).toEqual({
        strike: 1,
        threshold: RELAY_HARD_BOUNCE_STRIKES,
        unsubscribe: RELAY_HARD_BOUNCE_STRIKES <= 1,
      });
    });

    it('does not escalate on same-day repeats', async () => {
      const relay = await factories.createContact({projectId, email: 'abc123@privaterelay.appleid.com'});
      const now = new Date('2026-08-27T14:00:00Z');
      await bounceEvent(relay, new Date('2026-08-27T09:00:00Z'), {bounceType: 'Permanent', relayStrike: 1});
      await bounceEvent(relay, new Date('2026-08-27T11:00:00Z'), {bounceType: 'Permanent', relayStrike: 1});

      const verdict = await BounceService.evaluateRelayStrike(relay, userNotFound(relay.email), now);

      expect(verdict?.strike).toBe(1);
    });

    it('unsubscribes once the threshold is reached on distinct days', async () => {
      const relay = await factories.createContact({projectId, email: 'abc123@privaterelay.appleid.com'});
      const now = new Date('2026-08-27T14:00:00Z');
      for (let i = 1; i < RELAY_HARD_BOUNCE_STRIKES; i++) {
        await bounceEvent(relay, new Date(now.getTime() - i * DAY_MS), {bounceType: 'Permanent', relayStrike: i});
      }

      const verdict = await BounceService.evaluateRelayStrike(relay, userNotFound(relay.email), now);

      expect(verdict).toEqual({
        strike: RELAY_HARD_BOUNCE_STRIKES,
        threshold: RELAY_HARD_BOUNCE_STRIKES,
        unsubscribe: true,
      });
    });

    it('resets the count when the contact was re-subscribed after earlier strikes', async () => {
      const relay = await factories.createContact({projectId, email: 'abc123@privaterelay.appleid.com'});
      const now = new Date('2026-08-27T14:00:00Z');
      for (let i = 1; i < RELAY_HARD_BOUNCE_STRIKES; i++) {
        await bounceEvent(relay, new Date(now.getTime() - (i + 1) * DAY_MS), {bounceType: 'Permanent', relayStrike: i});
      }
      await prisma.event.create({
        data: {projectId, contactId: relay.id, name: 'contact.subscribed', createdAt: new Date(now.getTime() - DAY_MS)},
      });

      const verdict = await BounceService.evaluateRelayStrike(relay, userNotFound(relay.email), now);

      expect(verdict).toEqual({
        strike: 1,
        threshold: RELAY_HARD_BOUNCE_STRIKES,
        unsubscribe: RELAY_HARD_BOUNCE_STRIKES <= 1,
      });
    });

    it('ignores strikes that belong to a previous address of the contact', async () => {
      const relay = await factories.createContact({projectId, email: 'new456@privaterelay.appleid.com'});
      const now = new Date('2026-08-27T14:00:00Z');
      for (let i = 1; i < RELAY_HARD_BOUNCE_STRIKES; i++) {
        await bounceEvent(relay, new Date(now.getTime() - i * DAY_MS), {
          recipient: 'old123@privaterelay.appleid.com',
          bounceType: 'Permanent',
          relayStrike: i,
        });
      }

      const verdict = await BounceService.evaluateRelayStrike(relay, userNotFound(relay.email), now);

      expect(verdict?.strike).toBe(1);
    });

    it('ignores strikes outside the window and bounces recorded without a strike marker', async () => {
      const relay = await factories.createContact({projectId, email: 'abc123@privaterelay.appleid.com'});
      const now = new Date('2026-08-27T14:00:00Z');
      await bounceEvent(relay, new Date(now.getTime() - (RELAY_STRIKE_WINDOW_DAYS + 1) * DAY_MS), {
        bounceType: 'Permanent',
        relayStrike: 1,
      });
      // Historical hard bounce recorded before strike tracking existed — must not count
      await bounceEvent(relay, new Date(now.getTime() - 2 * DAY_MS), {bounceType: 'Permanent'});

      const verdict = await BounceService.evaluateRelayStrike(relay, userNotFound(relay.email), now);

      expect(verdict?.strike).toBe(1);
    });
  });

  describe('isHardBounced', () => {
    it('is true for a contact unsubscribed by a permanent bounce', async () => {
      const contact = await factories.createContact({projectId, email: 'dead@gmail.com', subscribed: false});
      await bounceEvent(contact, new Date(), {bounceType: 'Permanent'});

      expect(await BounceService.isHardBounced(contact)).toBe(true);
    });

    it('ignores tolerated relay strikes on a contact that was unsubscribed for another reason', async () => {
      const contact = await factories.createContact({
        projectId,
        email: 'abc123@privaterelay.appleid.com',
        subscribed: false,
      });
      await bounceEvent(contact, new Date(), {bounceType: 'Permanent', relayStrike: 1, unsubscribed: false});

      expect(await BounceService.isHardBounced(contact)).toBe(false);

      // The threshold strike is the bounce that unsubscribes — from then on the address is dead
      await bounceEvent(contact, new Date(), {
        bounceType: 'Permanent',
        relayStrike: RELAY_HARD_BOUNCE_STRIKES,
        unsubscribed: true,
      });

      expect(await BounceService.isHardBounced(contact)).toBe(true);
    });

    it('is false while the contact is subscribed, even with bounce history', async () => {
      const contact = await factories.createContact({projectId, email: 'abc123@privaterelay.appleid.com'});
      await bounceEvent(contact, new Date(), {bounceType: 'Permanent', relayStrike: 1});

      expect(await BounceService.isHardBounced(contact)).toBe(false);
    });

    it('is false for manual unsubscribes and for transient-only bounce history', async () => {
      const manual = await factories.createContact({projectId, email: 'manual@gmail.com', subscribed: false});
      expect(await BounceService.isHardBounced(manual)).toBe(false);

      const soft = await factories.createContact({projectId, email: 'soft@gmail.com', subscribed: false});
      await bounceEvent(soft, new Date(), {bounceType: 'Transient', transientBounce: true});
      expect(await BounceService.isHardBounced(soft)).toBe(false);
    });
  });
});
