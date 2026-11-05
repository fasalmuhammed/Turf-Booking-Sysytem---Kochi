/**
 * Ordered list of schema migrations. Never edit an existing entry once it has
 * shipped — append a new one instead. The index + 1 is stored in
 * PRAGMA user_version.
 *
 * Conventions:
 *  - Money is stored as whole rupees (INTEGER).
 *  - Times of day are minutes after midnight of the *operating date*. Values
 *    >= 1440 mean "after midnight" (e.g. 1500 = 01:00 next morning) so late
 *    night slots stay attached to the day they belong to.
 *  - Timestamps are epoch milliseconds (INTEGER).
 */
export const migrations: string[] = [
  /* 1: initial schema */ `
  CREATE TABLE locations (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL,
    address       TEXT NOT NULL DEFAULT '',
    maps_url      TEXT NOT NULL DEFAULT '',
    contact_phone TEXT NOT NULL DEFAULT '',
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE turfs (
    id                    INTEGER PRIMARY KEY,
    location_id           INTEGER NOT NULL REFERENCES locations(id),
    name                  TEXT NOT NULL,
    sports                TEXT NOT NULL DEFAULT 'Football',
    description           TEXT NOT NULL DEFAULT '',
    open_minute           INTEGER NOT NULL DEFAULT 360,
    close_minute          INTEGER NOT NULL DEFAULT 1380,
    slot_minutes          INTEGER NOT NULL DEFAULT 60,
    base_price            INTEGER NOT NULL DEFAULT 1000,
    advance_percent       INTEGER NOT NULL DEFAULT 30,
    max_slots_per_booking INTEGER NOT NULL DEFAULT 3,
    closed_days           TEXT NOT NULL DEFAULT '',
    active                INTEGER NOT NULL DEFAULT 1,
    sort_order            INTEGER NOT NULL DEFAULT 0,
    created_at            INTEGER NOT NULL,
    updated_at            INTEGER NOT NULL
  );

  -- Time-of-day / weekday price overrides (price is per hour)
  CREATE TABLE price_rules (
    id           INTEGER PRIMARY KEY,
    turf_id      INTEGER NOT NULL REFERENCES turfs(id) ON DELETE CASCADE,
    label        TEXT NOT NULL DEFAULT '',
    days         TEXT NOT NULL DEFAULT '',
    start_minute INTEGER NOT NULL,
    end_minute   INTEGER NOT NULL,
    price        INTEGER NOT NULL
  );

  CREATE TABLE offers (
    id             INTEGER PRIMARY KEY,
    turf_id        INTEGER REFERENCES turfs(id) ON DELETE CASCADE,
    title          TEXT NOT NULL,
    description    TEXT NOT NULL DEFAULT '',
    discount_type  TEXT NOT NULL CHECK (discount_type IN ('percent','flat')),
    discount_value INTEGER NOT NULL,
    valid_from     TEXT,
    valid_to       TEXT,
    days           TEXT NOT NULL DEFAULT '',
    start_minute   INTEGER,
    end_minute     INTEGER,
    min_slots      INTEGER NOT NULL DEFAULT 1,
    active         INTEGER NOT NULL DEFAULT 1,
    created_at     INTEGER NOT NULL
  );

  CREATE TABLE slot_blocks (
    id           INTEGER PRIMARY KEY,
    turf_id      INTEGER NOT NULL REFERENCES turfs(id) ON DELETE CASCADE,
    date         TEXT NOT NULL,
    start_minute INTEGER NOT NULL,
    end_minute   INTEGER NOT NULL,
    reason       TEXT NOT NULL DEFAULT '',
    created_by   INTEGER,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX idx_blocks_turf_date ON slot_blocks(turf_id, date);

  CREATE TABLE customers (
    id            INTEGER PRIMARY KEY,
    phone         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL DEFAULT '',
    whatsapp_name TEXT NOT NULL DEFAULT '',
    notes         TEXT NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL
  );

  CREATE TABLE bookings (
    id               INTEGER PRIMARY KEY,
    code             TEXT NOT NULL UNIQUE,
    turf_id          INTEGER NOT NULL REFERENCES turfs(id),
    customer_id      INTEGER NOT NULL REFERENCES customers(id),
    date             TEXT NOT NULL,
    start_minute     INTEGER NOT NULL,
    end_minute       INTEGER NOT NULL,
    contact_name     TEXT NOT NULL,
    contact_phone    TEXT NOT NULL,
    gross_amount     INTEGER NOT NULL,
    discount_amount  INTEGER NOT NULL DEFAULT 0,
    total_amount     INTEGER NOT NULL,
    offer_title      TEXT NOT NULL DEFAULT '',
    payment_option   TEXT NOT NULL DEFAULT 'full' CHECK (payment_option IN ('advance','full')),
    amount_required  INTEGER NOT NULL,
    amount_paid      INTEGER NOT NULL DEFAULT 0,
    status           TEXT NOT NULL CHECK (status IN ('pending_payment','confirmed','cancelled','expired','completed','no_show')),
    payment_status   TEXT NOT NULL CHECK (payment_status IN ('unpaid','verification_pending','advance_paid','paid','refund_pending','refunded')),
    hold_expires_at  INTEGER,
    reschedule_count INTEGER NOT NULL DEFAULT 0,
    reminder_sent_at INTEGER,
    cancel_reason    TEXT NOT NULL DEFAULT '',
    refund_amount    INTEGER NOT NULL DEFAULT 0,
    source           TEXT NOT NULL DEFAULT 'whatsapp',
    notes            TEXT NOT NULL DEFAULT '',
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    confirmed_at     INTEGER,
    cancelled_at     INTEGER
  );
  CREATE INDEX idx_bookings_turf_date ON bookings(turf_id, date, status);
  CREATE INDEX idx_bookings_customer ON bookings(customer_id);
  CREATE INDEX idx_bookings_status ON bookings(status);

  CREATE TABLE payments (
    id          INTEGER PRIMARY KEY,
    booking_id  INTEGER NOT NULL REFERENCES bookings(id),
    amount      INTEGER NOT NULL,
    method      TEXT NOT NULL,
    reference   TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL CHECK (status IN ('pending','success','failed','refunded')),
    provider_id TEXT NOT NULL DEFAULT '',
    note        TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    verified_at INTEGER,
    verified_by INTEGER
  );
  CREATE INDEX idx_payments_booking ON payments(booking_id);
  CREATE INDEX idx_payments_verified ON payments(status, verified_at);

  CREATE TABLE chat_sessions (
    phone              TEXT PRIMARY KEY,
    state              TEXT NOT NULL DEFAULT 'idle',
    data               TEXT NOT NULL DEFAULT '{}',
    mode               TEXT NOT NULL DEFAULT 'bot' CHECK (mode IN ('bot','human')),
    human_requested_at INTEGER,
    last_inbound_at    INTEGER,
    updated_at         INTEGER NOT NULL
  );

  CREATE TABLE messages (
    id            INTEGER PRIMARY KEY,
    phone         TEXT NOT NULL,
    direction     TEXT NOT NULL CHECK (direction IN ('in','out')),
    wa_message_id TEXT,
    type          TEXT NOT NULL,
    body          TEXT NOT NULL,
    sent_by_admin INTEGER,
    created_at    INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX idx_messages_wa_id ON messages(wa_message_id) WHERE wa_message_id IS NOT NULL AND direction = 'in';
  CREATE INDEX idx_messages_phone ON messages(phone, created_at);

  CREATE TABLE faqs (
    id         INTEGER PRIMARY KEY,
    question   TEXT NOT NULL,
    answer     TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    active     INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE admins (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    last_login_at INTEGER
  );

  CREATE TABLE admin_sessions (
    token_hash TEXT PRIMARY KEY,
    admin_id   INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE audit_log (
    id         INTEGER PRIMARY KEY,
    admin_id   INTEGER,
    action     TEXT NOT NULL,
    details    TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  `,
];
