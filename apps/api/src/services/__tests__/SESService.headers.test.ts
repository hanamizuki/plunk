import {describe, expect, it, type Mock} from 'vitest';
import {vi} from 'vitest';

// Mock the SES client so sendRawEmail builds the MIME message without touching AWS.
vi.mock('@aws-sdk/client-ses', () => {
  const SESMock = vi.fn();
  SESMock.prototype.sendRawEmail = vi.fn().mockResolvedValue({MessageId: 'test-message-id'});
  return {SES: SESMock};
});

// Pin the constants the header and the SES client read, preserving other exports.
// A project custom base is simulated so the "rewritten footer" case can be tested
// without depending on CUSTOM_UNSUBSCRIBE_URLS in the test environment.
vi.mock('../../app/constants.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../app/constants.js')>();
  return {
    ...actual,
    API_URI: 'https://api.plunk.test/',
    isPlunkUnsubscribeBase: (base: string) =>
      base === 'https://mail.custom.test' || actual.isPlunkUnsubscribeBase(base),
    AWS_SES_ACCESS_KEY_ID: 'test-key-id',
    AWS_SES_REGION: 'us-east-1',
    AWS_SES_SECRET_ACCESS_KEY: 'test-secret',
    SES_CONFIGURATION_SET: 'test-config-set',
    SES_CONFIGURATION_SET_NO_TRACKING: 'test-no-tracking-set',
    TRACKING_TOGGLE_ENABLED: true,
  };
});

import {DASHBOARD_URI} from '../../app/constants';
import {sendRawEmail, ses} from '../SESService';

const contactId = '11111111-1111-4111-8111-111111111111';
const oneClickPair = [
  `List-Unsubscribe: <https://api.plunk.test/unsubscribe/${contactId}>`,
  'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
];

/** Send one message and return the header section of the raw MIME SES received. */
async function headersFor(html: string, headers?: Record<string, string>): Promise<string> {
  (ses.sendRawEmail as Mock).mockClear();
  await sendRawEmail({
    from: {name: 'Plunk', email: 'hello@plunk.test'},
    to: ['someone@example.com'],
    content: {subject: 'Hello', html},
    headers,
  });
  const callArgs = (ses.sendRawEmail as Mock).mock.calls[0][0];
  const raw = new TextDecoder().decode(callArgs.RawMessage.Data);
  // RFC 5322 §2.1: the first blank line ends the header section.
  return raw.split('\n\n')[0];
}

describe('sendRawEmail List-Unsubscribe headers (RFC 8058)', () => {
  it("advertises the one-click pair, pointed at the API, when the body carries Plunk's unsubscribe link", async () => {
    const headers = await headersFor(`<p>Hi</p><a href="${DASHBOARD_URI}/unsubscribe/${contactId}">Unsubscribe</a>`);

    for (const line of oneClickPair) expect(headers).toContain(line);
  });

  it('still recognises the link after compile() rewrote it to a project custom base', async () => {
    const headers = await headersFor(`<a href="https://mail.custom.test/unsubscribe/${contactId}">Unsubscribe</a>`);

    for (const line of oneClickPair) expect(headers).toContain(line);
  });

  it('advertises a link Plunk does not manage as-is, with no one-click claim', async () => {
    const external = 'https://external-list.example/unsubscribe/deadbeef';
    const headers = await headersFor(`<a href="${external}">Unsubscribe</a>`);

    expect(headers).toContain(`List-Unsubscribe: <${external}>`);
    expect(headers).not.toContain('List-Unsubscribe-Post');
    expect(headers).not.toContain('api.plunk.test');
  });

  it('adds no List-Unsubscribe headers to mail without an unsubscribe link', async () => {
    const headers = await headersFor('<p>Your receipt</p>');

    expect(headers).not.toContain('List-Unsubscribe');
  });

  it('keeps caller headers and emits the pair after them inside the header section', async () => {
    const headers = await headersFor(`<a href="${DASHBOARD_URI}/unsubscribe/${contactId}">x</a>`, {'X-Custom': 'yes'});

    expect(headers).toMatch(
      /X-Custom: yes\nList-Unsubscribe: <[^>]+>\nList-Unsubscribe-Post: List-Unsubscribe=One-Click$/,
    );
  });
});
