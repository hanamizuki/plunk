import {Controller, Get, Post} from '@overnightjs/core';
import type {NextFunction, Request, Response} from 'express';

import {DASHBOARD_URI, getUnsubscribeBaseUrl} from '../app/constants.js';
import {prisma} from '../database/prisma.js';
import {ContactService} from '../services/ContactService.js';
import {CatchAsync} from '../utils/asyncHandler.js';

/**
 * List management endpoint advertised in the `List-Unsubscribe` header that
 * SESService adds to mail carrying Plunk's unsubscribe link (RFC 8058 one-click
 * unsubscribe). One URL serves two callers, dispatched by method:
 *
 * - `POST` — a mailbox provider acting on the recipient's "Unsubscribe" click.
 *   No human is present, so this must opt the contact out immediately and
 *   return success. Gmail and Yahoo only render their unsubscribe button when
 *   `List-Unsubscribe-Post` is present and the URL honours a bare POST.
 * - `GET` — a person who followed the header link in a mail client. Redirects
 *   to the project's unsubscribe page (custom base or dashboard), which asks
 *   for confirmation, so link scanners and prefetchers cannot opt anyone out.
 *
 * Both are public: a recipient cannot authenticate, and the contact id is an
 * unguessable UUID — the opaque identifier RFC 8058 §3.2 calls for.
 *
 * Keep this route exempt from any rate limiting added later: providers deliver
 * one-click POSTs in bursts, and a throttled unsubscribe sends the recipient to
 * the spam button instead.
 */
@Controller('unsubscribe')
export class Unsubscribe {
  /**
   * POST /unsubscribe/:id
   * PUBLIC: RFC 8058 one-click unsubscribe. The provider's body is
   * `List-Unsubscribe=One-Click`; it carries nothing we need, so it is ignored.
   */
  @Post(':id')
  @CatchAsync
  public async oneClick(req: Request, res: Response, _next: NextFunction) {
    const contactId = req.params.id;

    if (!contactId) {
      return res.status(400).type('text/plain').send('Contact ID is required');
    }

    const contact = await prisma.contact.findUnique({
      where: {id: contactId},
      select: {subscribed: true},
    });

    // Only act on a contact that is still subscribed: providers retry and people
    // click more than once, and a repeat must not fire a second
    // `contact.unsubscribed` event.
    if (contact?.subscribed) {
      await ContactService.unsubscribe(contactId);
    }

    // An unknown id reports success too. A 404 would tell an unauthenticated
    // caller which ids exist, and an error response makes providers retry a
    // request that can never succeed.
    return res.status(200).type('text/plain').send('Unsubscribed');
  }

  /**
   * GET /unsubscribe/:id
   * PUBLIC: a human followed the header link — hand them to the confirmation page.
   */
  @Get(':id')
  @CatchAsync
  public async redirect(req: Request, res: Response, _next: NextFunction) {
    const contactId = req.params.id;

    if (!contactId) {
      return res.status(400).type('text/plain').send('Contact ID is required');
    }

    // Use the same base the footer link was rewritten to (CUSTOM_UNSUBSCRIBE_URLS /
    // UNSUBSCRIBE_URI / DASHBOARD_URI), so header and footer land on one page.
    const contact = await prisma.contact.findUnique({
      where: {id: contactId},
      select: {projectId: true},
    });
    const base = (contact ? getUnsubscribeBaseUrl(contact.projectId) : DASHBOARD_URI).replace(/\/$/, '');

    return res.redirect(302, `${base}/unsubscribe/${encodeURIComponent(contactId)}`);
  }
}
