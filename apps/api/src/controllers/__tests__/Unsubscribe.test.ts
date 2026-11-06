import type {Request, Response} from 'express';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {DASHBOARD_URI} from '../../app/constants';
import {Unsubscribe} from '../Unsubscribe';
import {factories, getPrismaClient} from '../../../../../test/helpers';

/**
 * Minimal Express response double capturing what the controller sent.
 *
 * `sent` is the completion signal, and tests must await it rather than the
 * handler call: the `CatchAsync` decorator does not return the promise it
 * creates, so awaiting a decorated method resolves immediately, before any of
 * its async work has run. Express only ever observes the response, so this is
 * what "the handler finished" actually means here.
 */
function mockResponse() {
  const captured = {status: 200, body: '', contentType: '', redirectedTo: ''};

  let markSent: () => void;
  const sent = new Promise<void>(resolve => {
    markSent = resolve;
  });

  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    type(value: string) {
      captured.contentType = value;
      return this;
    },
    send(body: string) {
      captured.body = body;
      markSent();
      return this;
    },
    redirect(code: number, url: string) {
      captured.status = code;
      captured.redirectedTo = url;
      markSent();
      return this;
    },
  } as unknown as Response;

  return {res, captured, sent};
}

function mockRequest(id: string | undefined) {
  return {params: {id}, query: {}} as unknown as Request;
}

describe('Unsubscribe controller', () => {
  const prisma = getPrismaClient();
  const controller = new Unsubscribe();
  const next = vi.fn();

  let projectId: string;

  beforeEach(async () => {
    next.mockClear();
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
  });

  /** Invoke the one-click handler and wait for the response to be sent. */
  async function postOneClick(id: string | undefined) {
    const {res, captured, sent} = mockResponse();
    void controller.oneClick(mockRequest(id), res, next);
    await sent;
    // A handler that threw would reach `next` and leave the default status
    // untouched, which would otherwise read as a success.
    expect(next).not.toHaveBeenCalled();
    return captured;
  }

  /** Invoke the click-through handler and wait for the redirect to be sent. */
  async function getRedirect(id: string | undefined) {
    const {res, captured, sent} = mockResponse();
    void controller.redirect(mockRequest(id), res, next);
    await sent;
    expect(next).not.toHaveBeenCalled();
    return captured;
  }

  describe('POST /unsubscribe/:id (RFC 8058 one-click)', () => {
    it('unsubscribes a subscribed contact on a bare POST', async () => {
      const contact = await factories.createContact({projectId, subscribed: true});

      const captured = await postOneClick(contact.id);

      expect(captured.status).toBe(200);
      const updated = await prisma.contact.findUnique({where: {id: contact.id}});
      expect(updated?.subscribed).toBe(false);
    });

    it('is idempotent — a provider retry still succeeds and fires no second event', async () => {
      const contact = await factories.createContact({projectId, subscribed: true});

      await postOneClick(contact.id);
      const captured = await postOneClick(contact.id);

      expect(captured.status).toBe(200);
      const updated = await prisma.contact.findUnique({where: {id: contact.id}});
      expect(updated?.subscribed).toBe(false);

      const events = await prisma.event.findMany({where: {name: 'contact.unsubscribed', projectId}});
      expect(events).toHaveLength(1);
    });

    it('reports success for an unknown contact id rather than 404 or 500', async () => {
      const captured = await postOneClick('11111111-1111-4111-8111-111111111111');

      expect(captured.status).toBe(200);
    });

    it('rejects a missing contact id', async () => {
      const captured = await postOneClick(undefined);

      expect(captured.status).toBe(400);
    });
  });

  describe('GET /unsubscribe/:id (human click-through)', () => {
    it('redirects to the confirmation page without unsubscribing', async () => {
      const contact = await factories.createContact({projectId, subscribed: true});

      const captured = await getRedirect(contact.id);

      expect(captured.status).toBe(302);
      expect(captured.redirectedTo).toBe(`${DASHBOARD_URI.replace(/\/$/, '')}/unsubscribe/${contact.id}`);

      // A GET must not opt anyone out — link scanners and mail clients prefetch.
      const updated = await prisma.contact.findUnique({where: {id: contact.id}});
      expect(updated?.subscribed).toBe(true);
    });

    it('still redirects for an unknown id and encodes the id it forwards', async () => {
      const captured = await getRedirect('../../evil');

      expect(captured.status).toBe(302);
      expect(captured.redirectedTo).toBe(`${DASHBOARD_URI.replace(/\/$/, '')}/unsubscribe/..%2F..%2Fevil`);
    });
  });
});
