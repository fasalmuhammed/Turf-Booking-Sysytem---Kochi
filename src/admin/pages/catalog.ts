import type { Request, Router } from 'express';
import { busyIntervals, getSlots, isClosedDay } from '../../services/availability.js';
import {
  addPriceRule,
  createBlock,
  createLocation,
  createOffer,
  createTurf,
  deleteBlock,
  deleteFaq,
  deleteOffer,
  deletePriceRule,
  getLocation,
  getTurf,
  listBlocks,
  listFaqs,
  listLocations,
  listOffers,
  listPriceRules,
  listTurfs,
  removeLocation,
  removeTurf,
  saveFaq,
  setOfferActive,
  updateLocation,
  updateTurf,
  validateTurf,
  type TurfInput,
} from '../../services/catalog.js';
import type { Turf } from '../../types.js';
import { rupees } from '../../utils/misc.js';
import { addDays, dayName, formatDate, formatDateLong, formatMinute, formatRange, hhmmToMinute, isValidDate, minuteToHHMM, today } from '../../utils/time.js';
import { audit } from '../auth.js';
import { html } from '../html.js';
import { back, badge, body, checked, csrfField, empty, int, list, page, str } from '../layout.js';
import { closedDaysText } from '../../bot/support-flow.js';

const DAYS = [1, 2, 3, 4, 5, 6, 0];

function dayChecks(name: string, selected: string) {
  const sel = new Set(selected.split(',').filter(Boolean).map(Number));
  return html`<div>${DAYS.map((d) => html`<label class="check"><input type="checkbox" name="${name}" value="${d}" ${sel.has(d) ? 'checked' : ''}>${dayName(d)}</label>`)}</div>`;
}

const daysValue = (v: unknown) =>
  list(v)
    .map(Number)
    .filter((d) => d >= 0 && d <= 6)
    .sort()
    .join(',');

/** Reads open/close times; a close time at or before the open time means "after midnight". */
function readHours(openStr: string, closeStr: string): { open: number; close: number } | null {
  const open = hhmmToMinute(openStr);
  let close = hhmmToMinute(closeStr);
  if (open === null || close === null) return null;
  if (close <= open) close += 1440;
  return { open, close };
}

function turfForm(req: Request, t: Partial<Turf> | undefined, action: string) {
  const locations = listLocations();
  return html`<form class="card" method="post" action="${action}">${csrfField(req)}
    <div class="form-grid">
      <label>Location<select name="location_id" required>${locations.map((l) => html`<option value="${l.id}" ${t?.location_id === l.id ? 'selected' : ''}>${l.name}${l.active ? '' : ' (inactive)'}</option>`)}</select></label>
      <label>Turf name<input name="name" required maxlength="60" value="${t?.name ?? ''}" placeholder="e.g. Turf A (5-a-side)"></label>
      <label>Sports<input name="sports" maxlength="60" value="${t?.sports ?? 'Football'}" placeholder="Football, Cricket"></label>
      <label>Display order<input type="number" name="sort_order" value="${t?.sort_order ?? 0}"></label>
      <label class="full">Description<input name="description" maxlength="200" value="${t?.description ?? ''}" placeholder="Size, surface, floodlights…"></label>
      <label>Opens at<input type="time" name="open" value="${minuteToHHMM(t?.open_minute ?? 360)}" required></label>
      <label>Closes at <span class="hint">(earlier than opening = after midnight)</span><input type="time" name="close" value="${minuteToHHMM(t?.close_minute ?? 1380)}" required></label>
      <label>Slot duration<select name="slot_minutes">${[30, 60, 90, 120].map((m) => html`<option value="${m}" ${(t?.slot_minutes ?? 60) === m ? 'selected' : ''}>${m} minutes</option>`)}</select></label>
      <label>Max slots per booking<select name="max_slots_per_booking">${[1, 2, 3].map((m) => html`<option value="${m}" ${(t?.max_slots_per_booking ?? 3) === m ? 'selected' : ''}>${m}</option>`)}</select></label>
      <label>Standard price (₹ per hour)<input type="number" name="base_price" min="0" value="${t?.base_price ?? 1000}" required></label>
      <label>Advance payment %<span class="hint"> (0 or 100 = full payment only)</span><input type="number" name="advance_percent" min="0" max="100" value="${t?.advance_percent ?? 30}"></label>
      <label class="full">Closed on${dayChecks('closed_days', t?.closed_days ?? '')}</label>
      <label class="check full"><input type="checkbox" name="active" ${t?.active === 0 ? '' : 'checked'}> Open for booking</label>
    </div>
    <button class="btn primary">Save turf</button>
  </form>`;
}

function readTurf(req: Request): TurfInput | string {
  const b = body(req);
  const hours = readHours(str(b.open), str(b.close));
  if (!hours) return 'Please enter valid opening and closing times.';
  const t: TurfInput = {
    location_id: int(b.location_id),
    name: str(b.name, 60),
    sports: str(b.sports, 60) || 'Football',
    description: str(b.description, 200),
    open_minute: hours.open,
    close_minute: hours.close,
    slot_minutes: int(b.slot_minutes, 60),
    base_price: int(b.base_price),
    advance_percent: int(b.advance_percent),
    max_slots_per_booking: int(b.max_slots_per_booking, 1),
    closed_days: daysValue(b.closed_days),
    sort_order: int(b.sort_order),
    active: checked(b.active),
  };
  if (!getLocation(t.location_id)) return 'Please choose a location.';
  const errors = validateTurf(t);
  return errors.length ? errors.join(' ') : t;
}

function locationFields(l?: { name: string; address: string; maps_url: string; contact_phone: string; active: number }) {
  return html`<label>Name<input name="name" required maxlength="60" value="${l?.name ?? ''}"></label>
    <label>Address<input name="address" maxlength="200" value="${l?.address ?? ''}"></label>
    <label>Google Maps link<input name="maps_url" type="url" maxlength="300" value="${l?.maps_url ?? ''}"></label>
    <label>Contact phone<input name="contact_phone" maxlength="20" value="${l?.contact_phone ?? ''}"></label>
    <label class="check"><input type="checkbox" name="active" ${l?.active === 0 ? '' : 'checked'}> Active</label>`;
}

const readLocation = (req: Request) => {
  const b = body(req);
  const maps = str(b.maps_url, 300);
  return {
    name: str(b.name, 60),
    address: str(b.address, 200),
    maps_url: /^https?:\/\//i.test(maps) ? maps : '',
    contact_phone: str(b.contact_phone, 20),
    active: checked(b.active),
  };
};

export function registerCatalog(r: Router) {
  /* ------------------------------ Turfs ------------------------------ */
  r.get('/turfs', (req, res) => {
    const turfs = listTurfs();
    const locations = listLocations();
    res.send(
      page(req, 'Turfs & locations', [
        html`<div class="card tight"><div class="row between" style="padding:16px 18px 0"><h2>Turfs</h2><a class="btn primary" href="/admin/turfs/new">＋ Add turf</a></div>
          ${
            turfs.length
              ? html`<table><thead><tr><th>Turf</th><th>Location</th><th>Hours</th><th>Slots</th><th class="right">Price/hr</th><th>Advance</th><th>Status</th><th></th></tr></thead><tbody>
            ${turfs.map(
              (t) => html`<tr>
                <td><b>${t.name}</b><div class="small muted">${t.sports}</div></td>
                <td>${t.location_name}</td>
                <td class="nowrap">${formatRange(t.open_minute, t.close_minute)}<div class="small muted">${closedDaysText(t.closed_days)}</div></td>
                <td>${t.slot_minutes} min · max ${t.max_slots_per_booking}</td>
                <td class="right">${rupees(t.base_price)}</td>
                <td>${t.advance_percent > 0 && t.advance_percent < 100 ? `${t.advance_percent}%` : 'Full only'}</td>
                <td>${t.active && t.location_active ? badge('open', 'green') : badge('closed', 'grey')}</td>
                <td class="actions"><a class="btn sm" href="/admin/turfs/${t.id}">Edit</a> <a class="btn sm" href="/admin/schedule?turf=${t.id}">Schedule</a></td>
              </tr>`,
            )}</tbody></table>`
              : empty('No turfs yet — add your first turf.')
          }
        </div>
        <div class="card"><h2>Locations</h2>
          <p class="muted">Group turfs by venue. When you have more than one active location, customers pick the location first on WhatsApp.</p>
          ${locations.map(
            (l) => html`<form method="post" action="/admin/locations/${l.id}" class="form-grid" style="border-top:1px solid var(--line);padding-top:12px">${csrfField(req)}
              ${locationFields(l)}
              <div class="row"><button class="btn sm primary">Save</button>
              <button class="btn sm danger" formaction="/admin/locations/${l.id}/delete" data-confirm="Remove this location?">Remove</button></div>
            </form>`,
          )}
          <form method="post" action="/admin/locations" class="form-grid" style="border-top:1px solid var(--line);padding-top:12px">${csrfField(req)}
            <h3 class="full">Add location</h3>
            ${locationFields()}
            <div><button class="btn primary sm">Add location</button></div>
          </form>
        </div>`,
      ]),
    );
  });

  r.post('/locations', (req, res) => {
    const l = readLocation(req);
    if (!l.name) return back(req, res, '/admin/turfs', 'err', 'Location name is required.');
    const id = createLocation(l);
    audit(req.admin!.id, 'location.create', `${id} ${l.name}`);
    back(req, res, '/admin/turfs', 'ok', 'Location added.');
  });

  r.post('/locations/:id', (req, res) => {
    const l = readLocation(req);
    if (!l.name) return back(req, res, '/admin/turfs', 'err', 'Location name is required.');
    updateLocation(Number(req.params.id), l);
    audit(req.admin!.id, 'location.update', String(req.params.id));
    back(req, res, '/admin/turfs', 'ok', 'Location saved.');
  });

  r.post('/locations/:id/delete', (req, res) => {
    const result = removeLocation(Number(req.params.id));
    audit(req.admin!.id, 'location.remove', `${req.params.id} ${result}`);
    back(req, res, '/admin/turfs', 'ok', result === 'deleted' ? 'Location deleted.' : 'Location has turfs, so it (and its turfs) were deactivated instead.');
  });

  r.get('/turfs/new', (req, res) => {
    if (listLocations().length === 0) return back(req, res, '/admin/turfs', 'err', 'Add a location first.');
    res.send(page(req, 'Add turf', turfForm(req, undefined, '/admin/turfs')));
  });

  r.post('/turfs', (req, res) => {
    const t = readTurf(req);
    if (typeof t === 'string') return back(req, res, '/admin/turfs/new', 'err', t);
    const id = createTurf(t);
    audit(req.admin!.id, 'turf.create', `${id} ${t.name}`);
    back(req, res, `/admin/turfs/${id}`, 'ok', 'Turf created. Add peak-hour pricing below if needed.');
  });

  r.get('/turfs/:id', (req, res) => {
    const t = getTurf(Number(req.params.id));
    if (!t) return back(req, res, '/admin/turfs', 'err', 'Turf not found.');
    const rules = listPriceRules(t.id);
    res.send(
      page(req, `Edit ${t.name}`, [
        turfForm(req, t, `/admin/turfs/${t.id}`),
        html`<div class="card"><h2>Peak / special pricing</h2>
          <p class="muted">Override the standard hourly price for specific days and times (e.g. weekend evenings). The first matching rule applies.</p>
          ${
            rules.length
              ? html`<table><thead><tr><th>Label</th><th>Days</th><th>Time (slot start)</th><th class="right">₹/hr</th><th></th></tr></thead><tbody>
            ${rules.map(
              (p) => html`<tr><td>${p.label}</td><td>${p.days ? p.days.split(',').map((d) => dayName(Number(d))).join(', ') : 'Every day'}</td>
                <td>${formatMinute(p.start_minute)} – ${formatMinute(p.end_minute)}</td><td class="right">${rupees(p.price)}</td>
                <td class="actions"><form method="post" action="/admin/rules/${p.id}/delete" class="inline-form">${csrfField(req)}<input type="hidden" name="turf_id" value="${t.id}"><button class="btn sm danger">Delete</button></form></td></tr>`,
            )}</tbody></table>`
              : empty('No special pricing — the standard price applies to every slot.')
          }
          <form method="post" action="/admin/turfs/${t.id}/rules" class="form-grid" style="margin-top:14px">${csrfField(req)}
            <label>Label<input name="label" maxlength="40" placeholder="Evening peak"></label>
            <label>From<input type="time" name="start" value="18:00" required></label>
            <label>Until<input type="time" name="end" value="23:00" required></label>
            <label>Price (₹ per hour)<input type="number" name="price" min="0" required></label>
            <label class="full">Days <span class="hint">(none = every day)</span>${dayChecks('days', '')}</label>
            <div><button class="btn primary sm">Add pricing rule</button></div>
          </form>
        </div>
        <div class="card"><h2>Remove turf</h2>
          <p class="muted">Turfs with booking history are deactivated rather than deleted, so reports stay accurate.</p>
          <form method="post" action="/admin/turfs/${t.id}/delete">${csrfField(req)}<button class="btn danger" data-confirm="Remove this turf?">Remove turf</button></form>
        </div>`,
      ]),
    );
  });

  r.post('/turfs/:id', (req, res) => {
    const id = Number(req.params.id);
    const t = readTurf(req);
    if (typeof t === 'string') return back(req, res, `/admin/turfs/${id}`, 'err', t);
    updateTurf(id, t);
    audit(req.admin!.id, 'turf.update', `${id}`);
    back(req, res, `/admin/turfs/${id}`, 'ok', 'Turf saved. Existing bookings keep their original times and prices.');
  });

  r.post('/turfs/:id/delete', (req, res) => {
    const result = removeTurf(Number(req.params.id));
    audit(req.admin!.id, 'turf.remove', `${req.params.id} ${result}`);
    back(req, res, '/admin/turfs', 'ok', result === 'deleted' ? 'Turf deleted.' : 'Turf has bookings, so it was deactivated instead.');
  });

  r.post('/turfs/:id/rules', (req, res) => {
    const id = Number(req.params.id);
    const b = body(req);
    const start = hhmmToMinute(str(b.start));
    let end = hhmmToMinute(str(b.end));
    if (start === null || end === null) return back(req, res, `/admin/turfs/${id}`, 'err', 'Invalid times.');
    const turf = getTurf(id);
    if (!turf) return back(req, res, '/admin/turfs', 'err', 'Turf not found.');
    // align with the turf's minute scale (late-night hours are stored as 1440+)
    let s = start;
    if (s < turf.open_minute && s + 1440 < turf.close_minute) s += 1440;
    if (end <= s) end += 1440;
    addPriceRule({ turf_id: id, label: str(b.label, 40), days: daysValue(b.days), start_minute: s, end_minute: end, price: Math.max(0, int(b.price)) });
    audit(req.admin!.id, 'pricing.add', `${id}`);
    back(req, res, `/admin/turfs/${id}`, 'ok', 'Pricing rule added.');
  });

  r.post('/rules/:id/delete', (req, res) => {
    deletePriceRule(Number(req.params.id));
    back(req, res, `/admin/turfs/${int(body(req).turf_id)}`, 'ok', 'Pricing rule removed.');
  });

  /* ------------------------- Schedule & blocks ------------------------ */
  r.get('/schedule', (req, res) => {
    const turfs = listTurfs({ activeOnly: false });
    const turf = getTurf(Number(req.query.turf ?? turfs[0]?.id ?? 0));
    const date = isValidDate(String(req.query.date ?? '')) ? String(req.query.date) : today();
    if (!turf) {
      res.send(page(req, 'Schedule & blocks', empty('Add a turf first.')));
      return;
    }
    const slots = getSlots(turf, date);
    const busy = busyIntervals(turf.id, date);
    const bookingIds = new Map(busy.filter((b) => b.kind === 'booking').map((b) => [b.label.replace(/^held:/, ''), b.ref]));
    const blocks = listBlocks({ fromDate: today() });
    const starts: number[] = [];
    for (let s = turf.open_minute; s < turf.close_minute; s += turf.slot_minutes) starts.push(s);
    const ends = starts.map((s) => s + turf.slot_minutes);
    res.send(
      page(req, 'Schedule & blocks', [
        html`<form class="card filters" method="get">
          <label>Turf<select name="turf">${turfs.map((t) => html`<option value="${t.id}" ${t.id === turf.id ? 'selected' : ''}>${t.name} (${t.location_name})</option>`)}</select></label>
          <label>Date<input type="date" name="date" value="${date}"></label>
          <button class="btn primary">Show</button>
          <a class="btn" href="/admin/schedule?turf=${turf.id}&date=${addDays(date, -1)}">◀ Prev day</a>
          <a class="btn" href="/admin/schedule?turf=${turf.id}&date=${today()}">Today</a>
          <a class="btn" href="/admin/schedule?turf=${turf.id}&date=${addDays(date, 1)}">Next day ▶</a>
        </form>
        <div class="card">
          <div class="row between"><h2>${turf.name} · ${formatDateLong(date)}</h2>${isClosedDay(turf, date) ? badge('closed day', 'red') : ''}</div>
          <div class="legend"><span><i style="background:#cdeedb"></i>Available</span><span><i style="background:#cfe0f9"></i>Booked</span><span><i style="background:#ffe3b0"></i>Held (awaiting payment)</span><span><i style="background:#f8cfca"></i>Blocked</span><span><i style="background:#e5e5e5"></i>Past</span></div>
          <div class="slots">
            ${slots.map((s) => {
              const id = s.label ? bookingIds.get(s.label) : undefined;
              const detail =
                s.state === 'booked' || s.state === 'held'
                  ? html`<a href="/admin/bookings/${id}">${s.label}</a>`
                  : s.state === 'blocked'
                    ? s.label
                    : s.state === 'available'
                      ? html`${rupees(s.price)}${s.offer ? ` · 🔥 ${s.offer.title}` : ''}`
                      : s.state;
              return html`<div class="slot ${s.state}"><div class="t">${formatRange(s.start, s.end)}</div><div class="s">${detail}</div></div>`;
            })}
          </div>
          ${slots.some((s) => s.state === 'available') ? html`<p style="margin-top:14px"><a class="btn sm" href="/admin/bookings/new?turf=${turf.id}&date=${date}">＋ Create booking on this day</a></p>` : ''}
        </div>
        <div class="grid k2">
          <div class="card"><h2>Block slots</h2>
            <p class="muted">For maintenance, tournaments or private events. Blocked slots can't be booked on WhatsApp.</p>
            <form method="post" action="/admin/blocks" class="form-grid">${csrfField(req)}
              <input type="hidden" name="turf_id" value="${turf.id}">
              <label>Date<input type="date" name="date" value="${date}" required></label>
              <label>From<select name="start">${starts.map((s) => html`<option value="${s}">${formatMinute(s)}</option>`)}</select></label>
              <label>Until<select name="end">${ends.map((e, i) => html`<option value="${e}" ${i === ends.length - 1 ? 'selected' : ''}>${formatMinute(e)}</option>`)}</select></label>
              <label>Reason<input name="reason" maxlength="80" placeholder="Maintenance / private event"></label>
              <label class="check full"><input type="checkbox" name="all_turfs"> Apply to all turfs at ${turf.location_name}</label>
              <div><button class="btn primary">Block</button></div>
            </form>
          </div>
          <div class="card tight"><h2>Upcoming blocks</h2>
            ${
              blocks.length
                ? html`<table><thead><tr><th>Turf</th><th>Date</th><th>Time</th><th>Reason</th><th></th></tr></thead><tbody>
              ${blocks.map(
                (b) => html`<tr><td>${b.turf_name}</td><td>${formatDate(b.date)}</td><td class="nowrap">${formatRange(b.start_minute, b.end_minute)}</td><td>${b.reason}</td>
                  <td class="actions"><form method="post" action="/admin/blocks/${b.id}/delete" class="inline-form">${csrfField(req)}<button class="btn sm">Unblock</button></form></td></tr>`,
              )}</tbody></table>`
                : empty('No upcoming blocks.')
            }
          </div>
        </div>`,
      ]),
    );
  });

  r.post('/blocks', (req, res) => {
    const b = body(req);
    const turf = getTurf(int(b.turf_id));
    const date = str(b.date);
    const start = int(b.start);
    const end = int(b.end);
    if (!turf || !isValidDate(date) || end <= start) return back(req, res, '/admin/schedule', 'err', 'Please choose a valid date and time range.');
    const targets = checked(b.all_turfs) ? listTurfs({ locationId: turf.location_id }) : [turf];
    const conflicts: string[] = [];
    for (const t of targets) {
      for (const iv of busyIntervals(t.id, date)) {
        if (iv.kind === 'booking' && iv.start < end && start < iv.end) conflicts.push(`${t.name}: ${iv.label.replace(/^held:/, '')}`);
      }
    }
    if (conflicts.length) {
      return back(req, res, `/admin/schedule?turf=${turf.id}&date=${date}`, 'err', `These bookings overlap the block — cancel or move them first: ${conflicts.join(', ')}`);
    }
    for (const t of targets) createBlock({ turf_id: t.id, date, start_minute: start, end_minute: end, reason: str(b.reason, 80), created_by: req.admin!.id });
    audit(req.admin!.id, 'block.create', `${targets.map((t) => t.id).join(',')} ${date} ${start}-${end}`);
    back(req, res, `/admin/schedule?turf=${turf.id}&date=${date}`, 'ok', `Blocked ${formatRange(start, end)} on ${formatDate(date)}.`);
  });

  r.post('/blocks/:id/delete', (req, res) => {
    deleteBlock(Number(req.params.id));
    audit(req.admin!.id, 'block.delete', String(req.params.id));
    back(req, res, '/admin/schedule', 'ok', 'Block removed.');
  });

  /* ------------------------------ Offers ----------------------------- */
  r.get('/offers', (req, res) => {
    const offers = listOffers();
    const turfs = listTurfs();
    res.send(
      page(req, 'Offers', [
        html`<div class="card tight"><h2>Offers & discounts</h2>
          <p class="muted" style="padding:0 18px">Offers are applied automatically on WhatsApp. If several apply, the customer gets the biggest discount.</p>
          ${
            offers.length
              ? html`<table><thead><tr><th>Offer</th><th>Discount</th><th>Turf</th><th>When</th><th>Valid</th><th>Status</th><th></th></tr></thead><tbody>
            ${offers.map(
              (o) => html`<tr>
                <td><b>${o.title}</b><div class="small muted">${o.description}</div></td>
                <td>${o.discount_type === 'percent' ? `${o.discount_value}%` : rupees(o.discount_value)}${o.min_slots > 1 ? html`<div class="small muted">min ${o.min_slots} slots</div>` : ''}</td>
                <td>${o.turf_name ?? 'All turfs'}</td>
                <td class="small">${o.days ? o.days.split(',').map((d) => dayName(Number(d))).join(', ') : 'Every day'}${o.start_minute !== null && o.end_minute !== null ? html`<br>${formatMinute(o.start_minute)}–${formatMinute(o.end_minute)}` : ''}</td>
                <td class="small">${o.valid_from ?? '…'} → ${o.valid_to ?? '…'}</td>
                <td>${o.active ? badge('active', 'green') : badge('paused', 'grey')}</td>
                <td class="actions">
                  <form method="post" action="/admin/offers/${o.id}/toggle" class="inline-form">${csrfField(req)}<button class="btn sm">${o.active ? 'Pause' : 'Activate'}</button></form>
                  <form method="post" action="/admin/offers/${o.id}/delete" class="inline-form">${csrfField(req)}<button class="btn sm danger" data-confirm="Delete this offer?">Delete</button></form>
                </td></tr>`,
            )}</tbody></table>`
              : empty('No offers yet.')
          }
        </div>
        <form class="card" method="post" action="/admin/offers">${csrfField(req)}<h2>New offer</h2>
          <div class="form-grid">
            <label>Title<input name="title" required maxlength="30" placeholder="Morning Saver"></label>
            <label>Discount type<select name="discount_type"><option value="percent">Percent (%)</option><option value="flat">Flat (₹)</option></select></label>
            <label>Discount value<input type="number" name="discount_value" min="1" required></label>
            <label>Turf<select name="turf_id"><option value="">All turfs</option>${turfs.map((t) => html`<option value="${t.id}">${t.name}</option>`)}</select></label>
            <label class="full">Description<input name="description" maxlength="120" placeholder="Shown to customers on WhatsApp"></label>
            <label>Valid from<input type="date" name="valid_from"></label>
            <label>Valid until<input type="date" name="valid_to"></label>
            <label>Slot starts from <span class="hint">(optional)</span><input type="time" name="start"></label>
            <label>Slot starts before <span class="hint">(optional)</span><input type="time" name="end"></label>
            <label>Minimum slots<input type="number" name="min_slots" min="1" max="3" value="1"></label>
            <label class="full">Days <span class="hint">(none = every day)</span>${dayChecks('days', '')}</label>
            <label class="check full"><input type="checkbox" name="active" checked> Active</label>
          </div>
          <button class="btn primary">Create offer</button>
        </form>`,
      ]),
    );
  });

  r.post('/offers', (req, res) => {
    const b = body(req);
    const type = str(b.discount_type) === 'flat' ? 'flat' : 'percent';
    const value = int(b.discount_value);
    if (!str(b.title) || value <= 0 || (type === 'percent' && value > 100)) return back(req, res, '/admin/offers', 'err', 'Please enter a title and a valid discount.');
    const start = str(b.start) ? hhmmToMinute(str(b.start)) : null;
    let end = str(b.end) ? hhmmToMinute(str(b.end)) : null;
    if (start !== null && end !== null && end <= start) end += 1440;
    const from = isValidDate(str(b.valid_from)) ? str(b.valid_from) : null;
    const to = isValidDate(str(b.valid_to)) ? str(b.valid_to) : null;
    createOffer({
      turf_id: str(b.turf_id) ? int(b.turf_id) : null,
      title: str(b.title, 30),
      description: str(b.description, 120),
      discount_type: type,
      discount_value: value,
      valid_from: from,
      valid_to: to,
      days: daysValue(b.days),
      start_minute: start,
      end_minute: start !== null ? (end ?? 2880) : end,
      min_slots: Math.max(1, Math.min(3, int(b.min_slots, 1))),
      active: checked(b.active),
    });
    audit(req.admin!.id, 'offer.create', str(b.title));
    back(req, res, '/admin/offers', 'ok', 'Offer created.');
  });

  r.post('/offers/:id/toggle', (req, res) => {
    const o = listOffers().find((x) => x.id === Number(req.params.id));
    if (o) setOfferActive(o.id, !o.active);
    back(req, res, '/admin/offers', 'ok', 'Offer updated.');
  });

  r.post('/offers/:id/delete', (req, res) => {
    deleteOffer(Number(req.params.id));
    audit(req.admin!.id, 'offer.delete', String(req.params.id));
    back(req, res, '/admin/offers', 'ok', 'Offer deleted.');
  });

  /* ------------------------------- FAQs ------------------------------ */
  r.get('/faqs', (req, res) => {
    const faqs = listFaqs();
    const form = (f?: { id: number; question: string; answer: string; sort_order: number; active: number }) =>
      html`<form method="post" action="${f ? `/admin/faqs/${f.id}` : '/admin/faqs'}" class="card">${csrfField(req)}
        <div class="form-grid">
          <label class="full">Question<input name="question" required maxlength="120" value="${f?.question ?? ''}"></label>
          <label class="full">Answer<textarea name="answer" required maxlength="1000">${f?.answer ?? ''}</textarea></label>
          <label>Order<input type="number" name="sort_order" value="${f?.sort_order ?? faqs.length + 1}"></label>
          <label class="check"><input type="checkbox" name="active" ${f?.active === 0 ? '' : 'checked'}> Shown on WhatsApp</label>
        </div>
        <div class="row"><button class="btn primary sm">${f ? 'Save' : 'Add FAQ'}</button>
        ${f ? html`<button class="btn sm danger" formaction="/admin/faqs/${f.id}/delete" data-confirm="Delete this FAQ?">Delete</button>` : ''}</div>
      </form>`;
    res.send(
      page(req, 'FAQs', [
        html`<p class="muted">Customers can browse these in the WhatsApp help menu, and the bot also matches typed questions against them. Keep questions short (the first 24 characters show as the menu title).</p>`,
        ...faqs.map((f) => form(f)),
        html`<h2>Add a new FAQ</h2>`,
        form(),
      ]),
    );
  });

  const readFaq = (req: Request) => {
    const b = body(req);
    return { question: str(b.question, 120), answer: str(b.answer, 1000), sort_order: int(b.sort_order), active: checked(b.active) };
  };

  r.post('/faqs', (req, res) => {
    const f = readFaq(req);
    if (!f.question || !f.answer) return back(req, res, '/admin/faqs', 'err', 'Question and answer are required.');
    saveFaq(f);
    back(req, res, '/admin/faqs', 'ok', 'FAQ added.');
  });

  r.post('/faqs/:id', (req, res) => {
    const f = readFaq(req);
    if (!f.question || !f.answer) return back(req, res, '/admin/faqs', 'err', 'Question and answer are required.');
    saveFaq({ ...f, id: Number(req.params.id) });
    back(req, res, '/admin/faqs', 'ok', 'FAQ saved.');
  });

  r.post('/faqs/:id/delete', (req, res) => {
    deleteFaq(Number(req.params.id));
    back(req, res, '/admin/faqs', 'ok', 'FAQ deleted.');
  });
}
