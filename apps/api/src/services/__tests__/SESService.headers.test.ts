import {describe, expect, it, type Mock} from 'vitest';
import {vi} from 'vitest';

// Mock the SES client so sendRawEmail builds the MIME message without touching AWS.
vi.mock('@aws-sdk/client-ses', () => {
  const SESMock = vi.fn();
  SESMock.prototype.sendRawEmail = vi.fn().mockResolvedValue({MessageId: 'test-message-id'});
  return {SES: SESMock};
});

// Pin the constants the header and the SES client read, preserving other exports.
vi.mock('../../app/constants.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../app/constants.js')>();
  return {
    ...actual,
    API_URI: 'https://api.plunk.test/',
    AWS_SES_ACCESS_KEY_ID: 'test-key-id',
    AWS_SES_REGION: 'us-east-1',
    AWS_SES_SECRET_ACCESS_KEY: 'test-secret',
    SES_CONFIGURATION_SET: 'test-config-set',
    SES_CONFIGURATION_SET_NO_TRACKING: 'test-no-tracking-set',
    TRACKING_TOGGLE_ENABLED: true,
  };
});

import {sendRawEmail, ses} from '../SESService';

const contactId = '11111111-1111-4111-8111-111111111111';

/** Send one message and return the header section of the raw MIME SES received. */
async function headersFor(html: string): Promise<string> {
  (ses.sendRawEmail as Mock).mockClear();
  await sendRawEmail({
    from: {name: 'Plunk', email: 'hello@plunk.test'},
    to: ['someone@example.com'],
    content: {subject: 'Hello', html},
  });
  const callArgs = (ses.sendRawEmail as Mock).mock.calls[0][0];
  const raw = new TextDecoder().decode(callArgs.RawMessage.Data);
  // RFC 5322 §2.1: the first blank line ends the header section.
  return raw.split('\n\n')[0];
}

describe('sendRawEmail List-Unsubscribe headers (RFC 8058)', () => {
  it('advertises the one-click pair, pointed at the API endpoint, when the body carries the unsubscribe link', async () => {
    // The footer link may have been rewritten to a project's custom base; the
    // header must still target the API, which is where the one-click POST lands.
    const headers = await headersFor(
      `<p>Hi</p><a href="https://mail.custom.test/unsubscribe/${contactId}">Unsubscribe</a>`,
    );

    expect(headers).toContain(`List-Unsubscribe: <https://api.plunk.test/unsubscribe/${contactId}>`);
    expect(headers).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  });

  it('adds no List-Unsubscribe headers to mail without an unsubscribe link', async () => {
    const headers = await headersFor('<p>Your receipt</p>');

    expect(headers).not.toContain('List-Unsubscribe');
  });

  it('keeps caller headers and emits the pair after them inside the header section', async () => {
    (ses.sendRawEmail as Mock).mockClear();
    await sendRawEmail({
      from: {name: 'Plunk', email: 'hello@plunk.test'},
      to: ['someone@example.com'],
      content: {subject: 'Hello', html: `<a href="https://plunk.test/unsubscribe/${contactId}">x</a>`},
      headers: {'X-Custom': 'yes'},
    });
    const callArgs = (ses.sendRawEmail as Mock).mock.calls[0][0];
    const raw = new TextDecoder().decode(callArgs.RawMessage.Data);
    const headerSection = raw.split('\n\n')[0];

    expect(headerSection).toMatch(
      /X-Custom: yes\nList-Unsubscribe: <[^>]+>\nList-Unsubscribe-Post: List-Unsubscribe=One-Click$/,
    );
  });
});
