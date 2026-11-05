import { get } from './index.js';
import { addPriceRule, createLocation, createOffer, createTurf, saveFaq } from '../services/catalog.js';
import { setSettings } from '../services/settings.js';

/** Loads a demo venue so the bot works out of the box. Only runs on an empty database. */
export function seedDemoData(): boolean {
  if (get('SELECT 1 FROM locations LIMIT 1')) return false;

  const loc = createLocation({
    name: 'PlayZone Arena',
    address: '12, 5th Cross, Koramangala, Bengaluru 560034',
    maps_url: 'https://maps.google.com/?q=Koramangala+Bengaluru',
    contact_phone: '+91 90000 00000',
  });

  const football = createTurf({
    location_id: loc,
    name: 'Turf A · Football 7s',
    sports: 'Football',
    description: 'FIFA-grade artificial grass, floodlit, 7-a-side',
    open_minute: 6 * 60,
    close_minute: 24 * 60,
    slot_minutes: 60,
    base_price: 1200,
    advance_percent: 30,
    max_slots_per_booking: 3,
    closed_days: '',
    sort_order: 1,
    active: true,
  });
  addPriceRule({ turf_id: football, label: 'Evening peak', days: '', start_minute: 18 * 60, end_minute: 23 * 60, price: 1600 });
  addPriceRule({ turf_id: football, label: 'Weekend', days: '0,6', start_minute: 6 * 60, end_minute: 24 * 60, price: 1400 });

  const cricket = createTurf({
    location_id: loc,
    name: 'Turf B · Box Cricket',
    sports: 'Cricket',
    description: 'Netted box cricket arena, 8-a-side, open till 1 AM',
    open_minute: 6 * 60,
    close_minute: 25 * 60, // 1:00 AM next morning
    slot_minutes: 60,
    base_price: 1000,
    advance_percent: 25,
    max_slots_per_booking: 3,
    closed_days: '',
    sort_order: 2,
    active: true,
  });
  addPriceRule({ turf_id: cricket, label: 'Night', days: '', start_minute: 19 * 60, end_minute: 25 * 60, price: 1300 });

  createOffer({
    turf_id: null,
    title: 'Early Bird 20%',
    description: 'Play before 9 AM and save 20%',
    discount_type: 'percent',
    discount_value: 20,
    valid_from: null,
    valid_to: null,
    days: '',
    start_minute: 6 * 60,
    end_minute: 9 * 60,
    min_slots: 1,
    active: true,
  });
  createOffer({
    turf_id: null,
    title: '2-hour combo',
    description: '₹200 off when you book 2+ hours on weekdays',
    discount_type: 'flat',
    discount_value: 200,
    valid_from: null,
    valid_to: null,
    days: '1,2,3,4,5',
    start_minute: null,
    end_minute: null,
    min_slots: 2,
    active: true,
  });

  const faqs: [string, string][] = [
    ['Is parking available?', 'Yes — free parking for cars and bikes is available inside the venue.'],
    ['Do you provide equipment?', 'Footballs, cricket bats, balls and bibs are provided free of charge. Please bring your own shoes.'],
    ['What shoes are allowed?', 'Turf shoes, rubber studs or regular sports shoes. Metal studs are not allowed.'],
    ['How many players per side?', 'Turf A is for 7-a-side football (up to 16 players). Turf B box cricket fits 8 players per side.'],
    ['What if it rains?', 'If heavy rain makes play impossible, we will reschedule your booking for free or refund it in full.'],
    ['Changing rooms & washrooms?', 'Yes, separate changing rooms and washrooms with drinking water are available.'],
  ];
  faqs.forEach(([q, a], i) => saveFaq({ question: q, answer: a, sort_order: i + 1, active: true }));

  setSettings({ upi_vpa: 'yourbusiness@upi', upi_payee_name: 'PlayZone Turfs', support_phone: '+91 90000 00000' });
  return true;
}
