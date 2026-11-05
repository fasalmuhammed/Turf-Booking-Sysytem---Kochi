import express, { type Request, type Response } from 'express';
import QRCode from 'qrcode';
import { html } from '../admin/html.js';
import { afterPayment } from '../bot/notify.js';
import { getBookingByCode, recordPayment } from '../services/bookings.js';
import { amountDue, upiLink, verifyPaymentToken, verifyRazorpaySignature } from '../services/payments.js';
import { getSetting } from '../services/settings.js';
import { rupees } from '../utils/misc.js';
import { formatDateLong, formatRange } from '../utils/time.js';

export function publicRouter() {
  const router = express.Router();

  router.get('/healthz', (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  /** Customer-facing UPI payment page (QR code + "open UPI app" button). Linked from WhatsApp. */
  router.get('/pay/:code', async (req: Request, res: Response) => {
    const code = String(req.params.code ?? '').toUpperCase();
    const token = String(req.query.t ?? '');
    const b = /^TB[0-9A-Z]{6}$/.test(code) && verifyPaymentToken(code, token) ? getBookingByCode(code) : undefined;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!b) {
      res.status(404).send(payPage('Link not valid', html`<p>This payment link is invalid or has expired.</p>`));
      return;
    }
    const due = amountDue(b);
    const link = upiLink(b, due);
    let body;
    if (b.status === 'confirmed' && due === 0) {
      body = html`<div class="ok">✅ This booking is confirmed and fully paid.</div>`;
    } else if (b.status !== 'pending_payment' && b.status !== 'confirmed') {
      body = html`<div class="warn">This booking is ${b.status.replace('_', ' ')}. Please return to WhatsApp for help.</div>`;
    } else if (!link) {
      body = html`<div class="warn">Online UPI payment isn't set up yet. Our team will share payment details on WhatsApp.</div>`;
    } else {
      const qr = await QRCode.toDataURL(link, { margin: 1, width: 260 });
      body = html`
        <div class="amount">${rupees(due)}</div>
        <p class="muted">${b.payment_option === 'advance' && b.status === 'pending_payment' ? 'Advance payment' : 'Amount due'} for booking <b>${b.code}</b></p>
        <a class="btn" href="${link}">Pay with UPI app</a>
        <p class="muted small">On a computer? Scan this QR with any UPI app:</p>
        <img class="qr" src="${qr}" alt="UPI QR code" width="260" height="260">
        <p class="small">UPI ID: <b>${getSetting('upi_vpa')}</b><br>Note: <b>${b.code}</b></p>
        <div class="steps">After paying, go back to WhatsApp, tap <b>“I’ve paid”</b> and send the UPI reference number (UTR).</div>`;
    }
    res.send(
      payPage(
        `Pay for ${b.code}`,
        html`
          <h2>${b.turf_name}</h2>
          <p class="muted">${b.location_name}<br>${formatDateLong(b.date)} · ${formatRange(b.start_minute, b.end_minute)}</p>
          ${body}`,
      ),
    );
  });

  /** Razorpay → payment_link.paid confirms the booking automatically. */
  router.post('/webhooks/razorpay', async (req: Request, res: Response) => {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!rawBody || !verifyRazorpaySignature(rawBody, req.header('x-razorpay-signature'))) {
      res.sendStatus(401);
      return;
    }
    res.sendStatus(200);
    try {
      const event = req.body as {
        event: string;
        payload?: {
          payment_link?: { entity?: { notes?: { booking_code?: string } } };
          payment?: { entity?: { id: string; amount: number; method?: string; vpa?: string; acquirer_data?: { upi_transaction_id?: string; rrn?: string } } };
        };
      };
      if (event.event !== 'payment_link.paid') return;
      const code = event.payload?.payment_link?.entity?.notes?.booking_code;
      const payment = event.payload?.payment?.entity;
      if (!code || !payment) return;
      const b = getBookingByCode(code);
      if (!b) {
        console.warn('[razorpay] paid link for unknown booking', code);
        return;
      }
      const amount = Math.round(payment.amount / 100);
      const result = recordPayment(b.id, {
        amount,
        method: `razorpay${payment.method ? ':' + payment.method : ''}`,
        reference: payment.acquirer_data?.upi_transaction_id ?? payment.acquirer_data?.rrn ?? payment.id,
        providerId: payment.id,
      });
      await afterPayment(result, amount);
    } catch (err) {
      console.error('[razorpay] webhook handling failed', err);
    }
  });

  return router;
}

function payPage(title: string, content: unknown) {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>${title} · ${getSetting('business_name')}</title>
        <style>
          body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: #f1f5f2; margin: 0; color: #12261b; }
          .card { max-width: 420px; margin: 24px auto; background: #fff; border-radius: 16px; padding: 24px; text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,.06); }
          .brand { font-weight: 700; color: #0d7a43; letter-spacing: .3px; }
          h2 { margin: 12px 0 4px; }
          .muted { color: #5b6d62; } .small { font-size: 14px; }
          .amount { font-size: 40px; font-weight: 800; margin: 16px 0 4px; }
          .btn { display: block; background: #0d7a43; color: #fff; text-decoration: none; padding: 14px; border-radius: 10px; font-weight: 600; margin: 16px 0; font-size: 17px; }
          .qr { border: 1px solid #e3e9e5; border-radius: 12px; }
          .steps { background: #f6faf7; border-radius: 10px; padding: 12px; font-size: 14px; margin-top: 12px; }
          .ok { background: #e7f7ee; color: #0d7a43; padding: 14px; border-radius: 10px; margin-top: 16px; }
          .warn { background: #fff6e5; color: #8a5a00; padding: 14px; border-radius: 10px; margin-top: 16px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="brand">${getSetting('business_name')}</div>
          ${content}
        </div>
      </body>
    </html>`.value.replace(/^\s+/gm, '');
}
