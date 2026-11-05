import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeCustomer, makeTurf, mock, resetDb } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdmin } from '../src/admin/auth.js';
import { createBooking, getBooking } from '../src/services/bookings.js';
import { paymentPageUrl } from '../src/services/payments.js';
import { setSettings } from '../src/services/settings.js';
import { addDays, today } from '../src/utils/time.js';

let server: Server;
let base = '';

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const sign = (body: string, secret: string) => crypto.createHmac('sha256', secret).update(body).digest('hex');
const cookiesOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
const json = { 'Content-Type': 'application/json' };

describe('WhatsApp webhook', () => {
  beforeEach(resetDb);

  it('answers the Meta verification handshake only with the right token', async () => {
    const ok = await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), '12345');
    const bad = await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`);
    assert.equal(bad.status, 403);
  });

  it('rejects unsigned payloads and processes signed ones', async () => {
    makeTurf();
    const payload = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id: '919700000001', profile: { name: 'Asha' } }],
                messages: [{ from: '919700000001', id: 'wamid.1', timestamp: '1700000000', type: 'text', text: { body: 'hi' } }],
              },
            },
          ],
        },
      ],
    });
    const unsigned = await fetch(`${base}/webhooks/whatsapp`, { method: 'POST', headers: json, body: payload });
    assert.equal(unsigned.status, 401);
    const signed = await fetch(`${base}/webhooks/whatsapp`, {
      method: 'POST',
      headers: { ...json, 'X-Hub-Signature-256': `sha256=${sign(payload, 'wa-app-secret')}` },
      body: payload,
    });
    assert.equal(signed.status, 200);
    await new Promise((r) => setTimeout(r, 100));
    const replies = mock().outbox.get('919700000001') ?? [];
    assert.equal(replies.length, 1);
    assert.match(JSON.stringify(replies[0]!.msg), /Hi Asha/);
  });
});

describe('admin dashboard security', () => {
  beforeEach(() => {
    resetDb();
    createAdmin('owner', 'CorrectHorse42');
  });

  async function login(username: string, password: string, ip = '10.0.0.1') {
    const page = await fetch(`${base}/admin/login`);
    const token = /name="_login" value="([^"]+)"/.exec(await page.text())![1]!;
    return fetch(`${base}/admin/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookiesOf(page), 'X-Forwarded-For': ip },
      body: new URLSearchParams({ username, password, _login: token, next: '/admin' }),
    });
  }

  it('redirects anonymous users to the login page', async () => {
    const res = await fetch(`${base}/admin/bookings`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location')!, /^\/admin\/login/);
  });

  it('logs in, serves every page and enforces CSRF on changes', async () => {
    const res = await login('owner', 'CorrectHorse42', '10.0.0.2');
    assert.equal(res.status, 303);
    const cookie = cookiesOf(res);
    assert.match(cookie, /tb_admin=/);
    const pages = ['/admin', '/admin/bookings', '/admin/schedule', '/admin/payments', '/admin/turfs', '/admin/offers', '/admin/customers', '/admin/inbox', '/admin/faqs', '/admin/reports', '/admin/settings', '/admin/simulator', '/admin/bookings/new'];
    for (const path of pages) {
      const p = await fetch(`${base}${path}`, { headers: { Cookie: cookie } });
      assert.equal(p.status, 200, `${path} renders`);
    }
    const noCsrf = await fetch(`${base}/admin/settings`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'business_name=Hacked',
    });
    assert.equal(noCsrf.status, 403);
  });

  it('rejects login without the login form token', async () => {
    const res = await fetch(`${base}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=owner&password=CorrectHorse42',
    });
    assert.equal(res.status, 400);
  });

  it('locks out after repeated failed logins', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await login('owner', `wrong${i}`, '10.0.0.3')).status, 401);
    const locked = await login('owner', 'CorrectHorse42', '10.0.0.3');
    assert.equal(locked.status, 401);
    assert.match(await locked.text(), /Too many failed attempts/);
  });
});

describe('payments over HTTP', () => {
  beforeEach(() => {
    resetDb();
    setSettings({ upi_vpa: 'turf@okaxis' });
  });

  function booking() {
    const { turfId } = makeTurf();
    const c = makeCustomer('919755500000');
    return createBooking({
      turfId,
      customerId: c.id,
      date: addDays(today(), 1),
      startMinute: 1080,
      slots: 1,
      contactName: 'Meera',
      contactPhone: c.phone,
      paymentOption: 'full',
    });
  }

  it('serves the signed UPI payment page only with a valid token', async () => {
    const b = booking();
    const url = new URL(paymentPageUrl(b.code));
    const ok = await fetch(`${base}${url.pathname}${url.search}`);
    assert.equal(ok.status, 200);
    const html = await ok.text();
    assert.match(html, /upi:\/\/pay\?pa=turf%40okaxis/);
    assert.match(html, /data:image\/png;base64/);
    const forged = await fetch(`${base}/pay/${b.code}?t=deadbeef`);
    assert.equal(forged.status, 404);
  });

  it('confirms a booking from a signed Razorpay webhook', async () => {
    const b = booking();
    const payload = JSON.stringify({
      event: 'payment_link.paid',
      payload: {
        payment_link: { entity: { notes: { booking_code: b.code } } },
        payment: { entity: { id: 'pay_ABC', amount: 100000, method: 'upi', acquirer_data: { upi_transaction_id: '123456789012' } } },
      },
    });
    const bad = await fetch(`${base}/webhooks/razorpay`, { method: 'POST', headers: { ...json, 'X-Razorpay-Signature': 'x' }, body: payload });
    assert.equal(bad.status, 401);
    const good = await fetch(`${base}/webhooks/razorpay`, {
      method: 'POST',
      headers: { ...json, 'X-Razorpay-Signature': sign(payload, 'rzp-secret') },
      body: payload,
    });
    assert.equal(good.status, 200);
    await new Promise((r) => setTimeout(r, 100));
    const updated = getBooking(b.id)!;
    assert.equal(updated.status, 'confirmed');
    assert.equal(updated.amount_paid, 1000);
    assert.match(JSON.stringify(mock().outbox.get('919755500000')), /Booking confirmed/);
  });
});
