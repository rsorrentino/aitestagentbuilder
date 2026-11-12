/**
 * Test doubles for verification codes: a real IMAP server (hoodiecrow) that
 * test code "sends" emails to, and a fake Twilio Messages API.
 */

import http, { Server } from 'http';
import { AddressInfo } from 'net';
import { createRequire } from 'module';
import { ImapFlow } from 'imapflow';

const require = createRequire(import.meta.url);

export interface MailFixture {
  imapPort: number;
  twilioUrl: string;
  sendEmail(to: string, subject: string, text: string): Promise<void>;
  sendSms(to: string, body: string): void;
  close(): Promise<void>;
}

export const IMAP_USER = 'qa-inbox';
export const IMAP_PASSWORD = 'imap-pass-123';
export const TWILIO_SID = `AC${'0123456789abcdef'.repeat(2)}`;
export const TWILIO_TOKEN = 'twilio-token-123';

export async function startMailFixture(): Promise<MailFixture> {
  const hoodiecrow = require('hoodiecrow-imap');
  const imap = hoodiecrow({
    plugins: ['ID', 'IDLE', 'UNSELECT', 'ENABLE', 'CONDSTORE', 'SPECIAL-USE', 'LITERALPLUS', 'ESEARCH', 'SASL-IR', 'AUTH-PLAIN'],
    users: { [IMAP_USER]: { password: IMAP_PASSWORD } },
    storage: { INBOX: { messages: [] } },
  });
  await new Promise<void>((r) => imap.listen(0, '127.0.0.1', () => r()));
  const imapPort = (imap.server ?? imap).address().port;

  const sms: any[] = [];
  const twilio: Server = http.createServer((req, res) => {
    const auth = Buffer.from(String(req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
    if (auth !== `${TWILIO_SID}:${TWILIO_TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return void res.end('{"message":"Authenticate"}');
    }
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== `/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`) {
      res.writeHead(404);
      return void res.end();
    }
    const to = url.searchParams.get('To');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ messages: sms.filter((m) => !to || m.to === to).slice().reverse() }));
  });
  await new Promise<void>((r) => twilio.listen(0, '127.0.0.1', () => r()));

  return {
    imapPort,
    twilioUrl: `http://127.0.0.1:${(twilio.address() as AddressInfo).port}`,
    async sendEmail(to, subject, text) {
      const c = new ImapFlow({ host: '127.0.0.1', port: imapPort, secure: false, auth: { user: IMAP_USER, pass: IMAP_PASSWORD }, logger: false });
      await c.connect();
      try {
        await c.append('INBOX', `From: No Reply <noreply@example.net>\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: ${new Date().toUTCString()}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n`);
      } finally {
        await c.logout().catch(() => undefined);
      }
    },
    sendSms(to, body) {
      sms.push({ sid: `SM${Math.random().toString(16).slice(2)}`, to, from: '+15005550006', body, direction: 'inbound', date_sent: new Date().toUTCString() });
    },
    async close() {
      twilio.closeAllConnections();
      await new Promise((r) => twilio.close(r));
      await new Promise((r) => imap.close(r));
    },
  };
}

/** A code source config pointing at the fixture's mailbox. */
export const emailSource = (port: number, name = 'inbox') => ({
  name, type: 'email', host: '127.0.0.1', port, secure: false, username: IMAP_USER, password: IMAP_PASSWORD,
});
export const smsSource = (url: string, phone: string, name = 'phone') => ({
  name, type: 'sms', provider: 'twilio', account_sid: TWILIO_SID, auth_token: TWILIO_TOKEN, phone_number: phone, api_url: url,
});
