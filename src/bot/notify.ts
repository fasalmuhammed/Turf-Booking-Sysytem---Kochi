import { config, razorpayEnabled } from '../config.js';
import type { BookingView, PaymentResult } from '../services/bookings.js';
import { amountDue, createRazorpayLink, paymentPageUrl, upiLink } from '../services/payments.js';
import { getSetting } from '../services/settings.js';
import { displayPhone, rupees } from '../utils/misc.js';
import { formatDate, formatDateLong, formatMinute, formatRange, nowLocal } from '../utils/time.js';
import { sendMessage } from '../whatsapp/client.js';
import { bookingDetailsText, locationLine } from './format.js';
import { inServiceWindow } from './session.js';

export async function notifyAdmins(text: string) {
  for (const n of config.adminNumbers) await sendMessage(n, { kind: 'text', text: `🔔 *Admin alert*\n${text}` });
}

/** Payment step: Razorpay link (auto-verified) or UPI deep link / QR page + "I've paid" button. */
export async function sendPaymentInstructions(phone: string, b: BookingView) {
  const due = amountDue(b);
  const holdLine = b.hold_expires_at
    ? `⏳ Your slot is held until *${formatMinute(nowLocal(b.hold_expires_at).minute)}*. Please complete payment before then.`
    : '';
  const head =
    `💳 *Payment — ${rupees(due)}*${b.payment_option === 'advance' ? ` (advance; balance ${rupees(b.total_amount - due)} at the venue)` : ''}\n` +
    `Booking ID: *${b.code}*`;

  if (razorpayEnabled()) {
    const link = await createRazorpayLink(b, due);
    if (link) {
      await sendMessage(phone, {
        kind: 'cta',
        body: `${head}\n\nTap below to pay securely with any UPI app, card or netbanking. Your booking is confirmed automatically once the payment succeeds.\n\n${holdLine}`.trim(),
        displayText: `Pay ${rupees(due)}`,
        url: link.short_url,
        footer: 'Secured by Razorpay',
      });
      await sendMessage(phone, {
        kind: 'buttons',
        body: 'Need anything else?',
        buttons: [
          { id: `bk:${b.code}`, title: '📋 View booking' },
          { id: `cxl:${b.code}`, title: '❌ Cancel booking' },
        ],
      });
      return;
    }
  }

  const vpa = getSetting('upi_vpa');
  if (!vpa) {
    await sendMessage(phone, {
      kind: 'buttons',
      body: `${head}\n\nOur team will share payment details with you shortly. ${holdLine}`.trim(),
      buttons: [
        { id: 'human', title: '🙋 Talk to us' },
        { id: `cxl:${b.code}`, title: '❌ Cancel booking' },
      ],
    });
    await notifyAdmins(`Booking ${b.code} is waiting for payment but no UPI ID is configured (Settings → Payments).`);
    return;
  }

  const lines = [
    head,
    '',
    '*Pay via any UPI app* (GPay, PhonePe, Paytm, BHIM):',
    `• UPI ID: *${vpa}*`,
    `• Name: ${getSetting('upi_payee_name') || getSetting('business_name')}`,
    `• Amount: *${rupees(due)}*`,
    `• Note/remark: *${b.code}*`,
    '',
    holdLine,
    '',
    'After paying, tap *I’ve paid* and send the 12-digit UPI reference (UTR) or a screenshot.',
  ];
  const isHttps = config.publicBaseUrl.startsWith('https://');
  if (isHttps && upiLink(b, due)) {
    await sendMessage(phone, {
      kind: 'cta',
      body: lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n'),
      displayText: 'Open UPI / QR',
      url: paymentPageUrl(b.code),
    });
    await sendMessage(phone, {
      kind: 'buttons',
      body: `Done paying ${rupees(due)} for *${b.code}*?`,
      buttons: [
        { id: `paid:${b.code}`, title: '✅ I’ve paid' },
        { id: `cxl:${b.code}`, title: '❌ Cancel booking' },
      ],
    });
  } else {
    await sendMessage(phone, {
      kind: 'buttons',
      body: lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n'),
      buttons: [
        { id: `paid:${b.code}`, title: '✅ I’ve paid' },
        { id: `cxl:${b.code}`, title: '❌ Cancel booking' },
      ],
    });
  }
}

export async function sendBookingConfirmed(b: BookingView) {
  const rules = getSetting('turf_rules');
  const text = [
    bookingDetailsText(b, { title: '🎉 *Booking confirmed!*' }),
    '',
    locationLine(b.location_id),
    rules ? `\n*Please note:*\n${rules}` : '',
    '',
    'See you on the field! 🙌',
  ]
    .filter((l) => l !== undefined)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  await sendMessage(b.customer_phone, {
    kind: 'buttons',
    body: text,
    buttons: [
      { id: 'mybk', title: '📋 My bookings' },
      { id: 'menu', title: '🏠 Main menu' },
    ],
  });
}

export async function sendPaymentRejected(b: BookingView, note: string) {
  await sendMessage(b.customer_phone, {
    kind: 'buttons',
    body:
      `⚠️ We couldn't verify your payment for booking *${b.code}*.` +
      (note ? `\nReason: ${note}` : '') +
      `\n\nPlease check and try again, or talk to our team.`,
    buttons: [
      { id: `paid:${b.code}`, title: '✅ I’ve paid' },
      { id: `pay:${b.code}`, title: '💳 Payment details' },
      { id: 'human', title: '🙋 Talk to us' },
    ],
  });
}

export async function sendHoldExpired(b: BookingView) {
  if (!inServiceWindow(b.customer_phone)) return;
  await sendMessage(b.customer_phone, {
    kind: 'buttons',
    body: `⌛ Your hold on *${b.turf_name}*, ${formatDate(b.date)} ${formatRange(b.start_minute, b.end_minute)} (${b.code}) has expired because payment wasn't completed.\n\nIf you already paid, tap *I’ve paid* — we'll restore it if the slot is still free.`,
    buttons: [
      { id: 'book', title: '⚽ Book again' },
      { id: `paid:${b.code}`, title: '✅ I’ve paid' },
    ],
  });
}

export async function sendReminder(b: BookingView) {
  const name = b.contact_name.split(' ')[0] || 'there';
  const balance = b.total_amount - b.amount_paid;
  const text =
    `⏰ *Reminder:* Hi ${name}, your game is coming up!\n\n` +
    `🏟️ ${b.turf_name} (${b.location_name})\n📅 ${formatDateLong(b.date)}\n⏰ ${formatRange(b.start_minute, b.end_minute)}\n🆔 ${b.code}` +
    (balance > 0 ? `\n🧾 Balance payable at venue: ${rupees(balance)}` : '') +
    `\n\n${locationLine(b.location_id)}`;
  if (!inServiceWindow(b.customer_phone) && config.whatsapp.reminderTemplate) {
    await sendMessage(b.customer_phone, {
      kind: 'template',
      name: config.whatsapp.reminderTemplate,
      lang: config.whatsapp.templateLang,
      params: [name, b.turf_name, formatDateLong(b.date), formatRange(b.start_minute, b.end_minute)],
      fallbackText: text,
    });
  } else {
    await sendMessage(b.customer_phone, {
      kind: 'buttons',
      body: text,
      buttons: [
        { id: `bk:${b.code}`, title: '📋 View booking' },
        { id: 'human', title: '🙋 Talk to us' },
      ],
    });
  }
}

export async function sendCancelledByAdmin(b: BookingView, reason: string) {
  await sendMessage(b.customer_phone, {
    kind: 'buttons',
    body:
      `❌ Your booking *${b.code}* (${b.turf_name}, ${formatDate(b.date)} ${formatRange(b.start_minute, b.end_minute)}) has been cancelled by the turf team.` +
      (reason ? `\nReason: ${reason}` : '') +
      (b.refund_amount > 0 ? `\n\n↩️ A refund of ${rupees(b.refund_amount)} will be processed to your original payment method.` : '') +
      `\n\nWe're sorry for the inconvenience.`,
    buttons: [
      { id: 'book', title: '⚽ Book another slot' },
      { id: 'human', title: '🙋 Talk to us' },
    ],
  });
}

export async function sendRescheduledByAdmin(b: BookingView) {
  await sendMessage(b.customer_phone, {
    kind: 'buttons',
    body: bookingDetailsText(b, { title: '🔄 *Your booking has been rescheduled by the turf team.* Here are the updated details:' }),
    buttons: [
      { id: 'mybk', title: '📋 My bookings' },
      { id: 'human', title: '🙋 Talk to us' },
    ],
  });
}

export async function sendRefundProcessed(b: BookingView) {
  await sendMessage(b.customer_phone, {
    kind: 'text',
    text: `↩️ Your refund of *${rupees(b.refund_amount)}* for booking *${b.code}* has been processed. It may take 3–5 working days to reflect in your account.`,
  });
}

export async function sendPaymentReceived(b: BookingView, amount: number) {
  await sendMessage(b.customer_phone, {
    kind: 'text',
    text: `✅ Payment of *${rupees(amount)}* received for booking *${b.code}*. Total paid: ${rupees(b.amount_paid)} of ${rupees(b.total_amount)}.`,
  });
}

/** Messages the customer (and admins when needed) after a payment has been recorded. */
export async function afterPayment(result: PaymentResult, amount: number) {
  const b = result.booking;
  if (result.confirmedNow) {
    await sendBookingConfirmed(b);
  } else if (result.conflict) {
    await sendMessage(b.customer_phone, {
      kind: 'buttons',
      body:
        `⚠️ We received your payment of ${rupees(amount)} for *${b.code}*, but the slot was booked by someone else after your hold expired.\n\n` +
        `↩️ A full refund of ${rupees(b.refund_amount)} will be processed. Sorry for the trouble!`,
      buttons: [
        { id: 'book', title: '⚽ Book another slot' },
        { id: 'human', title: '🙋 Talk to us' },
      ],
    });
    await notifyAdmins(`⚠️ Payment received after slot was lost — refund ${rupees(b.refund_amount)} needed\n${adminBookingLine(b)}`);
  } else {
    await sendPaymentReceived(b, amount);
  }
}

export const adminBookingLine = (b: BookingView) =>
  `${b.code} · ${b.turf_name} · ${formatDate(b.date)} ${formatRange(b.start_minute, b.end_minute)} · ${b.contact_name} (${displayPhone(b.contact_phone)})`;
