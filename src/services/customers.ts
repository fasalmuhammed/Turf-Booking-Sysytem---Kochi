import { all, get, run } from '../db/index.js';
import type { Customer } from '../types.js';

export function upsertCustomer(phone: string, whatsappName = ''): Customer {
  const now = Date.now();
  run(
    `INSERT INTO customers (phone, whatsapp_name, created_at, last_seen_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(phone) DO UPDATE SET last_seen_at = excluded.last_seen_at,
       whatsapp_name = CASE WHEN excluded.whatsapp_name <> '' THEN excluded.whatsapp_name ELSE customers.whatsapp_name END`,
    phone,
    whatsappName,
    now,
    now,
  );
  return get<Customer>('SELECT * FROM customers WHERE phone = ?', phone)!;
}

export const getCustomer = (id: number) => get<Customer>('SELECT * FROM customers WHERE id = ?', id);
export const getCustomerByPhone = (phone: string) => get<Customer>('SELECT * FROM customers WHERE phone = ?', phone);

export function setCustomerName(id: number, name: string) {
  run('UPDATE customers SET name = ? WHERE id = ?', name, id);
}

export function setCustomerNotes(id: number, notes: string) {
  run('UPDATE customers SET notes = ? WHERE id = ?', notes, id);
}

export interface CustomerSummary extends Customer {
  bookings: number;
  active_bookings: number;
  total_spent: number;
  last_booking_date: string | null;
}

export function listCustomers(search = '', limit = 200): CustomerSummary[] {
  const q = `%${search.trim()}%`;
  return all<CustomerSummary>(
    `SELECT c.*,
            COUNT(b.id) AS bookings,
            SUM(CASE WHEN b.status IN ('pending_payment','confirmed') THEN 1 ELSE 0 END) AS active_bookings,
            COALESCE(SUM(b.amount_paid), 0) AS total_spent,
            MAX(b.date) AS last_booking_date
       FROM customers c LEFT JOIN bookings b ON b.customer_id = c.id
      WHERE (? = '%%' OR c.phone LIKE ? OR c.name LIKE ? OR c.whatsapp_name LIKE ?)
      GROUP BY c.id
      ORDER BY c.last_seen_at DESC
      LIMIT ?`,
    q,
    q,
    q,
    q,
    limit,
  );
}
