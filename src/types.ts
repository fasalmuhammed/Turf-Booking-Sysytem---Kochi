export interface Location {
  id: number;
  name: string;
  address: string;
  maps_url: string;
  contact_phone: string;
  active: number;
  created_at: number;
}

export interface Turf {
  id: number;
  location_id: number;
  name: string;
  sports: string;
  description: string;
  open_minute: number;
  close_minute: number;
  slot_minutes: number;
  base_price: number;
  advance_percent: number;
  max_slots_per_booking: number;
  closed_days: string;
  active: number;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface PriceRule {
  id: number;
  turf_id: number;
  label: string;
  days: string;
  start_minute: number;
  end_minute: number;
  price: number;
}

export interface Offer {
  id: number;
  turf_id: number | null;
  title: string;
  description: string;
  discount_type: 'percent' | 'flat';
  discount_value: number;
  valid_from: string | null;
  valid_to: string | null;
  days: string;
  start_minute: number | null;
  end_minute: number | null;
  min_slots: number;
  active: number;
  created_at: number;
}

export interface SlotBlock {
  id: number;
  turf_id: number;
  date: string;
  start_minute: number;
  end_minute: number;
  reason: string;
  created_by: number | null;
  created_at: number;
}

export interface Customer {
  id: number;
  phone: string;
  name: string;
  whatsapp_name: string;
  notes: string;
  created_at: number;
  last_seen_at: number;
}

export type BookingStatus = 'pending_payment' | 'confirmed' | 'cancelled' | 'expired' | 'completed' | 'no_show';
export type PaymentStatus = 'unpaid' | 'verification_pending' | 'advance_paid' | 'paid' | 'refund_pending' | 'refunded';

export interface Booking {
  id: number;
  code: string;
  turf_id: number;
  customer_id: number;
  date: string;
  start_minute: number;
  end_minute: number;
  contact_name: string;
  contact_phone: string;
  gross_amount: number;
  discount_amount: number;
  total_amount: number;
  offer_title: string;
  payment_option: 'advance' | 'full';
  amount_required: number;
  amount_paid: number;
  status: BookingStatus;
  payment_status: PaymentStatus;
  hold_expires_at: number | null;
  reschedule_count: number;
  reminder_sent_at: number | null;
  cancel_reason: string;
  refund_amount: number;
  source: string;
  notes: string;
  created_at: number;
  updated_at: number;
  confirmed_at: number | null;
  cancelled_at: number | null;
}

export interface Payment {
  id: number;
  booking_id: number;
  amount: number;
  method: string;
  reference: string;
  status: 'pending' | 'success' | 'failed' | 'refunded';
  provider_id: string;
  note: string;
  created_at: number;
  verified_at: number | null;
  verified_by: number | null;
}

export interface Faq {
  id: number;
  question: string;
  answer: string;
  sort_order: number;
  active: number;
}

/** Statuses that occupy a slot on the calendar. */
export const ACTIVE_BOOKING_STATUSES: BookingStatus[] = ['pending_payment', 'confirmed', 'completed', 'no_show'];
