import type { Router } from 'express';
import { config } from '../../config.js';
import { all, run } from '../../db/index.js';
import { handleInbound } from '../../bot/engine.js';
import { humanQueue, inServiceWindow, loadSession, setMode } from '../../bot/session.js';
import { recentForCustomer } from '../../services/bookings.js';
import { getCustomer, getCustomerByPhone, listCustomers, setCustomerNotes } from '../../services/customers.js';
import { displayPhone, randomCode, rupees } from '../../utils/misc.js';
import { formatDate, formatDateTime, formatRange } from '../../utils/time.js';
import { getTransport, isMock, MockTransport, sendMessage } from '../../whatsapp/client.js';
import type { InboundMessage } from '../../whatsapp/types.js';
import { audit } from '../auth.js';
import { html } from '../html.js';
import { back, badge, body, csrfField, empty, page, statusBadge, str } from '../layout.js';

const validPhone = (p: string) => /^\d{8,15}$/.test(p);

export function registerPeople(r: Router) {
  /* ---------------------------- Customers ---------------------------- */
  r.get('/customers', (req, res) => {
    const q = String(req.query.q ?? '').slice(0, 60);
    const rows = listCustomers(q);
    res.send(
      page(req, 'Customers', [
        html`<form class="card filters" method="get"><label>Search<input name="q" value="${q}" placeholder="Name or phone"></label><button class="btn primary">Search</button></form>
        <div class="card tight">${
          rows.length
            ? html`<div class="table-wrap"><table><thead><tr><th>Customer</th><th>WhatsApp</th><th class="right">Bookings</th><th class="right">Upcoming</th><th class="right">Total paid</th><th>Last booking</th><th>Last seen</th><th></th></tr></thead><tbody>
          ${rows.map(
            (c) => html`<tr>
              <td><b>${c.name || c.whatsapp_name || '—'}</b>${c.name && c.whatsapp_name && c.name !== c.whatsapp_name ? html`<div class="small muted">WA: ${c.whatsapp_name}</div>` : ''}</td>
              <td class="nowrap">${displayPhone(c.phone)}</td>
              <td class="right">${c.bookings}</td><td class="right">${c.active_bookings ?? 0}</td><td class="right">${rupees(c.total_spent)}</td>
              <td>${c.last_booking_date ? formatDate(c.last_booking_date) : '—'}</td>
              <td class="small">${formatDateTime(c.last_seen_at)}</td>
              <td class="actions"><a class="btn sm" href="/admin/customers/${c.id}">Open</a> <a class="btn sm" href="/admin/inbox/${c.phone}">Chat</a></td>
            </tr>`,
          )}</tbody></table></div>`
            : empty('No customers yet.')
        }</div>`,
      ]),
    );
  });

  r.get('/customers/:id', (req, res) => {
    const c = getCustomer(Number(req.params.id));
    if (!c) return back(req, res, '/admin/customers', 'err', 'Customer not found.');
    const bookings = recentForCustomer(c.id, 100);
    const paid = bookings.reduce((a, b) => a + b.amount_paid, 0);
    res.send(
      page(req, c.name || c.whatsapp_name || displayPhone(c.phone), [
        html`<div class="grid k2">
          <div class="card"><dl class="kv">
            <dt>Name</dt><dd>${c.name || '—'}</dd>
            <dt>WhatsApp name</dt><dd>${c.whatsapp_name || '—'}</dd>
            <dt>WhatsApp number</dt><dd>${displayPhone(c.phone)} · <a href="/admin/inbox/${c.phone}">open chat</a></dd>
            <dt>Customer since</dt><dd>${formatDateTime(c.created_at)}</dd>
            <dt>Last seen</dt><dd>${formatDateTime(c.last_seen_at)}</dd>
            <dt>Bookings</dt><dd>${bookings.length} · ${rupees(paid)} paid</dd>
          </dl></div>
          <form class="card" method="post" action="/admin/customers/${c.id}/notes">${csrfField(req)}
            <label>Internal notes<textarea name="notes" maxlength="1000">${c.notes}</textarea></label>
            <button class="btn sm">Save notes</button>
          </form>
        </div>
        <div class="section-gap"></div>
        <div class="card tight"><h2>Bookings</h2>${
          bookings.length
            ? html`<table><thead><tr><th>ID</th><th>When</th><th>Turf</th><th>Status</th><th>Payment</th><th class="right">Total</th></tr></thead><tbody>
          ${bookings.map((b) => html`<tr><td class="mono"><a href="/admin/bookings/${b.id}">${b.code}</a></td><td>${formatDate(b.date)} ${formatRange(b.start_minute, b.end_minute)}</td><td>${b.turf_name}</td><td>${statusBadge(b.status)}</td><td>${statusBadge(b.payment_status)}</td><td class="right">${rupees(b.total_amount)}</td></tr>`)}
          </tbody></table>`
            : empty('No bookings yet.')
        }</div>`,
      ]),
    );
  });

  r.post('/customers/:id/notes', (req, res) => {
    setCustomerNotes(Number(req.params.id), str(body(req).notes, 1000));
    back(req, res, `/admin/customers/${req.params.id}`, 'ok', 'Notes saved.');
  });

  /* ------------------------------ Inbox ------------------------------ */
  r.get('/inbox', (req, res) => {
    const queue = humanQueue();
    const recent = all<{ phone: string; last_at: number; body: string; direction: string; name: string | null; wa: string | null; mode: string | null }>(
      `SELECT m.phone, m.created_at AS last_at, m.body, m.direction, c.name, c.whatsapp_name AS wa, s.mode
         FROM messages m
         JOIN (SELECT phone, MAX(id) AS id FROM messages GROUP BY phone) last ON last.id = m.id
         LEFT JOIN customers c ON c.phone = m.phone
         LEFT JOIN chat_sessions s ON s.phone = m.phone
        WHERE m.phone NOT LIKE 'sim%'
        ORDER BY m.id DESC LIMIT 60`,
    );
    res.send(
      page(req, 'Inbox', [
        html`<div class="card tight"><h2>Waiting for a team member (${queue.length})</h2>${
          queue.length
            ? html`<table><thead><tr><th>Customer</th><th>Requested</th><th>Last message</th><th></th></tr></thead><tbody>
          ${queue.map((q) => html`<tr><td><b>${q.name || q.whatsapp_name || '—'}</b><div class="small muted">${displayPhone(q.phone)}</div></td><td class="small">${q.human_requested_at ? formatDateTime(q.human_requested_at) : ''}</td><td>${q.last_message ?? ''}</td><td class="actions"><a class="btn primary sm" href="/admin/inbox/${q.phone}">Reply</a></td></tr>`)}
          </tbody></table>`
            : empty('Nobody is waiting. The bot is handling all chats.')
        }</div>
        <div class="card tight"><h2>Recent conversations</h2>${
          recent.length
            ? html`<table><thead><tr><th>Customer</th><th>Last message</th><th>When</th><th>Mode</th><th></th></tr></thead><tbody>
          ${recent.map((m) => html`<tr><td><b>${m.name || m.wa || '—'}</b><div class="small muted">${displayPhone(m.phone)}</div></td><td>${m.direction === 'out' ? html`<span class="muted">You/bot: </span>` : ''}${m.body.slice(0, 90)}</td><td class="small">${formatDateTime(m.last_at)}</td><td>${m.mode === 'human' ? badge('human', 'amber') : badge('bot', 'green')}</td><td class="actions"><a class="btn sm" href="/admin/inbox/${m.phone}">Open</a></td></tr>`)}
          </tbody></table>`
            : empty('No conversations yet.')
        }</div>`,
      ]),
    );
  });

  r.get('/inbox/:phone', (req, res) => {
    const phone = String(req.params.phone);
    if (!validPhone(phone) && !phone.startsWith('sim')) return back(req, res, '/admin/inbox', 'err', 'Invalid number.');
    const msgs = all<{ id: number; direction: string; type: string; body: string; sent_by_admin: number | null; created_at: number }>(
      'SELECT * FROM (SELECT * FROM messages WHERE phone = ? ORDER BY id DESC LIMIT 300) ORDER BY id',
      phone,
    );
    const session = loadSession(phone);
    const customer = getCustomerByPhone(phone);
    const windowOpen = inServiceWindow(phone);
    res.send(
      page(req, `Chat · ${customer?.name || customer?.whatsapp_name || displayPhone(phone)}`, [
        html`<div class="card">
          <div class="row between">
            <div>${session.mode === 'human' ? badge('You are handling this chat — bot paused', 'amber') : badge('Bot is handling this chat', 'green')}
              ${customer ? html` <a class="small" href="/admin/customers/${customer.id}">customer profile</a>` : ''}</div>
            <form method="post" action="/admin/inbox/${phone}/mode" class="row">${csrfField(req)}
              ${
                session.mode === 'human'
                  ? html`<input type="hidden" name="mode" value="bot"><button class="btn">🤖 Hand back to bot</button>`
                  : html`<input type="hidden" name="mode" value="human"><button class="btn">✋ Take over (pause bot)</button>`
              }
            </form>
          </div>
        </div>
        <div class="card">
          <div class="chat" id="chat">
            ${msgs.map((m) => {
              const media = /media:(\d+)/.exec(m.body)?.[1];
              return html`<div class="bubble ${m.direction} ${m.sent_by_admin ? 'admin' : ''}">${m.body}${media ? html`<br><a href="/admin/media/${media}" target="_blank" rel="noopener">View attachment</a>` : ''}<span class="meta">${m.sent_by_admin ? 'Team · ' : m.direction === 'out' ? 'Bot · ' : ''}${formatDateTime(m.created_at)}${m.type.endsWith(':failed') ? ' · ⚠ not delivered' : ''}</span></div>`;
            })}
          </div>
          ${!windowOpen ? html`<div class="flash err" style="margin-top:12px">The customer hasn't messaged in the last 24 hours, so WhatsApp only allows approved template messages. Free-text replies will probably not be delivered.</div>` : ''}
          <form method="post" action="/admin/inbox/${phone}/reply" style="margin-top:12px">${csrfField(req)}
            <label>Reply as ${config.whatsapp.mode === 'mock' ? '(mock mode)' : 'your business'}<textarea name="text" required maxlength="4000" placeholder="Type your reply…"></textarea></label>
            <div class="row"><button class="btn primary">Send reply</button><span class="small muted">Sending a reply pauses the bot for this chat until you hand it back.</span></div>
          </form>
        </div>`,
      ]),
    );
  });

  r.post('/inbox/:phone/reply', async (req, res) => {
    const phone = String(req.params.phone);
    const text = str(body(req).text, 4000);
    if (!text || (!validPhone(phone) && !phone.startsWith('sim'))) return back(req, res, `/admin/inbox/${phone}`, 'err', 'Nothing to send.');
    const s = loadSession(phone);
    if (s.mode !== 'human') setMode(phone, 'human');
    const ok = await sendMessage(phone, { kind: 'text', text }, { adminId: req.admin!.id });
    audit(req.admin!.id, 'inbox.reply', phone);
    back(req, res, `/admin/inbox/${phone}`, ok ? 'ok' : 'err', ok ? 'Reply sent.' : 'WhatsApp rejected the message (see server logs).');
  });

  r.post('/inbox/:phone/mode', async (req, res) => {
    const phone = String(req.params.phone);
    const mode = str(body(req).mode) === 'human' ? 'human' : 'bot';
    setMode(phone, mode);
    audit(req.admin!.id, 'inbox.mode', `${phone} ${mode}`);
    if (mode === 'bot' && inServiceWindow(phone)) {
      await sendMessage(phone, {
        kind: 'buttons',
        body: "Thanks for chatting with us! 🙏 You're back with our booking assistant.",
        buttons: [
          { id: 'book', title: '⚽ Book a turf' },
          { id: 'mybk', title: '📋 My bookings' },
          { id: 'menu', title: '🏠 Main menu' },
        ],
      });
    }
    back(req, res, `/admin/inbox/${phone}`, 'ok', mode === 'bot' ? 'Chat handed back to the bot.' : 'You are now handling this chat; the bot is paused.');
  });

  /* ------------------------- Media (screenshots) ---------------------- */
  r.get('/media/:id', async (req, res) => {
    const id = String(req.params.id);
    if (!/^\d+$/.test(id) || config.whatsapp.mode !== 'cloud') {
      res.status(404).send('Media is only available when connected to the WhatsApp Cloud API.');
      return;
    }
    const auth = { Authorization: `Bearer ${config.whatsapp.token}` };
    const meta = await fetch(`https://graph.facebook.com/${config.whatsapp.apiVersion}/${id}`, { headers: auth });
    if (!meta.ok) {
      res.status(404).send('Media not found or expired (WhatsApp keeps media for 30 days).');
      return;
    }
    const info = (await meta.json()) as { url: string; mime_type: string };
    if (!/^(image\/(jpeg|png|webp)|application\/pdf)$/.test(info.mime_type)) {
      res.status(415).send('Unsupported media type.');
      return;
    }
    const file = await fetch(info.url, { headers: auth });
    res.setHeader('Content-Type', info.mime_type);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'");
    res.send(Buffer.from(await file.arrayBuffer()));
  });

  /* ----------------------------- Simulator ---------------------------- */
  r.get('/simulator', (req, res) => {
    if (!isMock()) return back(req, res, '/admin', 'err', 'The simulator is only available when WHATSAPP_MODE=mock.');
    res.send(
      page(
        req,
        'WhatsApp simulator',
        html`<meta name="csrf" content="${req.admin!.csrf}">
        <div class="sim">
          <div class="phone">
            <div class="bar">💬 <span id="sim-title">Customer chat</span></div>
            <div class="msgs" id="sim-msgs"></div>
            <form id="sim-form"><input id="sim-text" autocomplete="off" placeholder="Type a message (try “hi”)"><button class="btn primary">Send</button></form>
          </div>
          <div class="card">
            <h2>Test the bot without WhatsApp</h2>
            <p class="muted">This chat runs through exactly the same bot logic as real WhatsApp messages. Tap buttons and list rows just like on a phone. Bookings made here are real records in your database.</p>
            <label>Customer WhatsApp number<input id="sim-phone" value="919999900001"></label>
            <label>Customer WhatsApp profile name<input id="sim-name" value="Test Player"></label>
            <div class="row"><button class="btn" id="sim-reset" type="button">Reset this conversation</button></div>
            <p class="small muted" style="margin-top:14px">Tip: open <b>Payments</b> in another tab to verify a payment claim and watch the confirmation arrive here.</p>
          </div>
        </div>`,
        { scripts: ['/static/sim.js'] },
      ),
    );
  });

  r.get('/simulator/messages', (req, res) => {
    const phone = String(req.query.phone ?? '');
    const t = getTransport();
    if (!(t instanceof MockTransport) || !validPhone(phone)) {
      res.json({ messages: [] });
      return;
    }
    const inbound = all<{ body: string; created_at: number; id: number }>(
      "SELECT id, body, created_at FROM messages WHERE phone = ? AND direction = 'in' ORDER BY id DESC LIMIT 200",
      phone,
    ).map((m) => ({ dir: 'in', at: m.created_at, seq: m.id, text: m.body }));
    const outbound = (t.outbox.get(phone) ?? []).map((m, i) => ({ dir: 'out', at: m.at, seq: i, msg: m.msg }));
    const merged = [...inbound, ...outbound].sort((a, b) => a.at - b.at || (a.dir === b.dir ? a.seq - b.seq : a.dir === 'in' ? -1 : 1));
    res.json({ messages: merged });
  });

  r.post('/simulator/send', async (req, res) => {
    const b = body(req);
    const phone = str(b.phone, 15);
    if (!isMock() || !validPhone(phone)) {
      res.status(400).json({ error: 'invalid' });
      return;
    }
    const replyId = str(b.replyId, 256);
    const msg: InboundMessage = {
      from: phone,
      id: `sim.${Date.now()}.${randomCode(6)}`,
      profileName: str(b.name, 60),
      timestamp: Date.now(),
      kind: replyId ? 'reply' : 'text',
      text: str(b.text, 1000),
      replyId,
      rawType: replyId ? 'interactive' : 'text',
    };
    await handleInbound(msg);
    res.json({ ok: true });
  });

  r.post('/simulator/reset', (req, res) => {
    const phone = str(body(req).phone, 15);
    const t = getTransport();
    if (t instanceof MockTransport && validPhone(phone)) {
      t.clear(phone);
      run('DELETE FROM messages WHERE phone = ?', phone);
      run('DELETE FROM chat_sessions WHERE phone = ?', phone);
    }
    res.json({ ok: true });
  });
}
