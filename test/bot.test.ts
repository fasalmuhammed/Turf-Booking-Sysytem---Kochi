import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bodyText, makeTurf, mock, optionIds, resetDb, say, tap } from './helpers.js';
import { get } from '../src/db/index.js';
import { getBookingByCode, recordPayment } from '../src/services/bookings.js';
import { afterPayment } from '../src/bot/notify.js';
import { saveFaq } from '../src/services/catalog.js';
import { setSettings } from '../src/services/settings.js';
import { loadSession } from '../src/bot/session.js';
import { toCloudPayload } from '../src/whatsapp/client.js';
import { addDays, today } from '../src/utils/time.js';

const PHONE = '919876500001';

/** Walks the happy path up to the booking summary for tomorrow's first evening slot. */
async function bookUntilSummary(phone = PHONE) {
  await say(phone, 'hi');
  let r = await tap(phone, 'book');
  const tomorrow = `date:${addDays(today(), 1)}`;
  assert.ok(optionIds(r).includes(tomorrow), 'tomorrow is offered');
  r = await tap(phone, tomorrow);
  assert.ok(optionIds(r).includes('period:evening'), 'busy days ask for the time of day first');
  r = await tap(phone, 'period:evening');
  const slot = optionIds(r).find((id) => id === 'slot:1080');
  assert.ok(slot, '6 PM slot offered');
  r = await tap(phone, slot!);
  assert.deepEqual(optionIds(r), ['dur:1', 'dur:2', 'dur:3']);
  r = await tap(phone, 'dur:2');
  // first booking: name not known yet → offers WhatsApp profile name
  assert.ok(optionIds(r).includes('name:profile'));
  r = await say(phone, 'Ravi Kumar');
  assert.ok(optionIds(r).includes('phone:wa'));
  r = await tap(phone, 'phone:wa');
  assert.match(bodyText(r), /Booking summary/);
  return r;
}

describe('WhatsApp bot conversation', () => {
  beforeEach(() => {
    resetDb();
    setSettings({ upi_vpa: 'turf@okaxis', upi_payee_name: 'Test Turfs' });
  });

  it('greets new customers with the main menu', async () => {
    makeTurf();
    const r = await say(PHONE, 'Hello');
    assert.match(bodyText(r), /Welcome to/);
    assert.deepEqual(optionIds(r), ['book', 'mybk', 'faq']);
  });

  it('books a slot end-to-end with an advance UPI payment', async () => {
    makeTurf();
    const summary = await bookUntilSummary();
    assert.match(bodyText(summary), /₹2,000/);
    let r = await tap(PHONE, 'sum:confirm');
    assert.deepEqual(optionIds(r), ['payopt:advance', 'payopt:full']);
    r = await tap(PHONE, 'payopt:advance');
    const text = bodyText(r);
    assert.match(text, /Slot reserved/);
    assert.match(text, /₹600/);
    const code = /TB[0-9A-Z]{6}/.exec(text)![0];
    assert.ok(optionIds(r).includes(`paid:${code}`));

    const booking = getBookingByCode(code)!;
    assert.equal(booking.status, 'pending_payment');
    assert.equal(booking.contact_name, 'Ravi Kumar');

    // Customer claims payment with a UTR
    r = await tap(PHONE, `paid:${code}`);
    assert.match(bodyText(r), /UTR/);
    r = await say(PHONE, '4123 4567 8901');
    assert.match(bodyText(r), /verifying your payment/);
    assert.equal(getBookingByCode(code)!.payment_status, 'verification_pending');
    // admins are alerted
    assert.match(bodyText((mock().outbox.get('919000000001') ?? []).map((m) => m.msg)), /Payment to verify/);

    // Admin verifies → customer gets confirmation
    const claim = get<{ id: number }>("SELECT id FROM payments WHERE status = 'pending'")!;
    const result = recordPayment(booking.id, { amount: 600, method: 'upi', claimId: claim.id, verifiedBy: 1 });
    const before = mock().outbox.get(PHONE)!.length;
    await afterPayment(result, 600);
    const confirmation = mock().outbox.get(PHONE)!.slice(before).map((m) => m.msg);
    assert.match(bodyText(confirmation), /Booking confirmed/);
    assert.match(bodyText(confirmation), /Balance at venue:\* ₹1,400/);
  });

  it('lets the customer view and cancel a booking', async () => {
    makeTurf();
    await bookUntilSummary();
    await tap(PHONE, 'sum:confirm');
    const r1 = await tap(PHONE, 'payopt:full');
    const code = /TB[0-9A-Z]{6}/.exec(bodyText(r1))![0];

    let r = await say(PHONE, 'my bookings');
    assert.match(bodyText(r), new RegExp(code));
    assert.ok(optionIds(r).includes(`cxl:${code}`));
    r = await tap(PHONE, `cxl:${code}`);
    assert.ok(optionIds(r).includes(`cxlyes:${code}`));
    r = await tap(PHONE, `cxlyes:${code}`);
    assert.match(bodyText(r), /has been cancelled/);
    assert.equal(getBookingByCode(code)!.status, 'cancelled');
  });

  it('does not let one customer act on another customer’s booking', async () => {
    makeTurf();
    await bookUntilSummary();
    await tap(PHONE, 'sum:confirm');
    const code = /TB[0-9A-Z]{6}/.exec(bodyText(await tap(PHONE, 'payopt:full')))![0];
    const r = await tap('919811112222', `cxlyes:${code}`);
    assert.match(bodyText(r), /couldn't find booking/);
    assert.equal(getBookingByCode(code)!.status, 'pending_payment');
  });

  it('tells the second customer when a slot was just taken', async () => {
    makeTurf();
    const other = '919800000002';
    await bookUntilSummary(PHONE);
    await bookUntilSummary(other);
    await tap(PHONE, 'sum:confirm');
    await tap(PHONE, 'payopt:full');
    await tap(other, 'sum:confirm');
    const r = await tap(other, 'payopt:full');
    assert.match(bodyText(r), /just been booked by someone else/);
    const bookings = get<{ n: number }>("SELECT COUNT(*) AS n FROM bookings WHERE status = 'pending_payment'")!.n;
    assert.equal(bookings, 1);
  });

  it('accepts typed option numbers and handles unknown text gracefully', async () => {
    makeTurf();
    await say(PHONE, 'hi');
    const r = await say(PHONE, '1'); // first button = Book a turf
    assert.match(bodyText(r), /Which day/);
    const fallback = await say(PHONE, 'asdfghjkl');
    assert.match(bodyText(fallback), /didn't get that/);
  });

  it('answers FAQs from free text and hands off to a human', async () => {
    makeTurf();
    saveFaq({ question: 'Is parking available?', answer: 'Yes, free parking inside.', sort_order: 1, active: true });
    await say(PHONE, 'hi');
    let r = await say(PHONE, 'is there parking?');
    assert.match(bodyText(r), /free parking/);
    r = await say(PHONE, 'I want to talk to a person');
    assert.match(bodyText(r), /team has been notified/);
    assert.equal(loadSession(PHONE).mode, 'human');
    r = await say(PHONE, 'hello?');
    assert.equal(r.length, 0, 'bot stays silent while a human handles the chat');
    r = await say(PHONE, 'menu');
    assert.equal(loadSession(PHONE).mode, 'bot');
    assert.deepEqual(optionIds(r), ['book', 'mybk', 'faq']);
  });

  it('shows prices, offers and policies', async () => {
    makeTurf();
    await say(PHONE, 'hi');
    assert.match(bodyText(await say(PHONE, 'what are your prices')), /₹1,000\/hr/);
    assert.match(bodyText(await tap(PHONE, 'info:policy')), /Cancellation/);
  });

  it('deduplicates webhook retries of the same message', async () => {
    makeTurf();
    const { handleInbound } = await import('../src/bot/engine.js');
    const msg = { from: PHONE, id: 'wamid.dupe', profileName: 'R', timestamp: Date.now(), kind: 'text' as const, text: 'hi', replyId: '', rawType: 'text' };
    await handleInbound(msg);
    await handleInbound(msg);
    assert.equal(mock().outbox.get(PHONE)!.length, 1);
  });

  it('builds Cloud API payloads within WhatsApp limits', () => {
    const p = toCloudPayload('91999', {
      kind: 'list',
      body: 'x',
      button: 'A very long button label here',
      sections: [{ title: 'Section', rows: Array.from({ length: 14 }, (_, i) => ({ id: `r${i}`, title: `A long row title number ${i}`, description: 'd' })) }],
    }) as { interactive: { action: { button: string; sections: { rows: { title: string }[] }[] } } };
    assert.ok(p.interactive.action.button.length <= 20);
    assert.equal(p.interactive.action.sections[0]!.rows.length, 10);
    assert.ok(p.interactive.action.sections[0]!.rows.every((r) => r.title.length <= 24));
  });
});
