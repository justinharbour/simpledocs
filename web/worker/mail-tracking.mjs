// PostGrid mailing classes offered for transmissions. The extra services are
// US-only; PostGrid adds the tracking number once the letter is processed.
export const TRACKED_CLASSES = ['certified', 'certified_return_receipt', 'registered', 'usps_express_3_day'];
export const MAIL_CLASSES = ['first_class', 'standard_class', ...TRACKED_CLASSES];

const STATUSES = ['ready', 'printing', 'processed_for_delivery', 'completed', 'cancelled'];
const IMB = ['entered_mail_stream', 'out_for_delivery', 'returned_to_sender'];
const EMPTY_EVENTS = '{"status":[],"imb":[]}';
const date = v => (typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const zip = v => (typeof v === 'string' && /^[0-9A-Za-z -]{3,10}$/.test(v) ? v : null);

export function trackingFrom(letter) {
  const status = (Array.isArray(letter?.statusEvents) ? letter.statusEvents : [])
    .filter(e => STATUSES.includes(e?.status) && date(e.date)).slice(0, 50)
    .map(e => ({ status: e.status, date: date(e.date) }));
  const imb = (Array.isArray(letter?.imbEvents) ? letter.imbEvents : [])
    .filter(e => IMB.includes(e?.status) && date(e.date)).slice(0, 200)
    .map(e => ({ status: e.status, date: date(e.date), zipCode: zip(e.zipCode), scanCode: typeof e.scanCode === 'string' && /^[A-Za-z0-9]{1,8}$/.test(e.scanCode) ? e.scanCode : null }));
  return {
    trackingNumber: typeof letter?.trackingNumber === 'string' && /^[A-Za-z0-9]{6,40}$/.test(letter.trackingNumber) ? letter.trackingNumber : null,
    imbStatus: IMB.includes(letter?.imbStatus) ? letter.imbStatus : null,
    imbDate: date(letter?.imbDate),
    imbZIPCode: zip(letter?.imbZIPCode),
    events: { status, imb },
  };
}

// Stores what PostGrid reported. A change also writes the provider's letter
// record (without its expiring preview link) to R2 as an audit snapshot.
export async function recordTracking(env, row, letter, now = new Date().toISOString()) {
  const t = trackingFrom(letter);
  const events = JSON.stringify(t.events);
  const prior = await env.DB.prepare('SELECT tracking_number, imb_status, imb_date, events_json FROM mail_tracking WHERE delivery_id = ?').bind(row.id).first();
  const changed = !prior
    || (t.trackingNumber && t.trackingNumber !== prior.tracking_number)
    || (t.imbStatus && t.imbStatus !== prior.imb_status)
    || (t.imbDate && t.imbDate !== prior.imb_date)
    || (events !== EMPTY_EVENTS && events !== prior.events_json);
  if (changed && env.FILES) {
    const { url: _preview, ...snapshot } = letter ?? {};
    await env.FILES.put(`outbound/${row.transmission_id}/mail/${row.id}/tracking/${now}.json`, new TextEncoder().encode(JSON.stringify({ fetchedAt: now, letter: snapshot })), { httpMetadata: { contentType: 'application/json' } });
  }
  await env.DB.prepare(`INSERT INTO mail_tracking (delivery_id, tracking_number, imb_status, imb_date, imb_zip, events_json, checked_at, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(delivery_id) DO UPDATE SET tracking_number = COALESCE(excluded.tracking_number, tracking_number), imb_status = COALESCE(excluded.imb_status, imb_status),
    imb_date = COALESCE(excluded.imb_date, imb_date), imb_zip = COALESCE(excluded.imb_zip, imb_zip),
    events_json = CASE WHEN excluded.events_json = '${EMPTY_EVENTS}' THEN events_json ELSE excluded.events_json END,
    checked_at = excluded.checked_at, changed_at = COALESCE(excluded.changed_at, changed_at)`)
    .bind(row.id, t.trackingNumber, t.imbStatus, t.imbDate, t.imbZIPCode, events, now, changed ? now : null).run();
  if (changed && prior) await env.DB.prepare('UPDATE transmissions SET updated_at = ? WHERE id = ?').bind(now, row.transmission_id).run();
  return changed;
}

export async function touchTracking(env, id, now = new Date().toISOString()) {
  await env.DB.prepare('INSERT INTO mail_tracking (delivery_id, checked_at) VALUES (?, ?) ON CONFLICT(delivery_id) DO UPDATE SET checked_at = excluded.checked_at').bind(id, now).run();
}

export function trackingView(row, track, transmissionId) {
  let mailingClass = null;
  try { mailingClass = JSON.parse(row.options_json).mailingClass ?? null; } catch { /* Older rows. */ }
  if (!track && !TRACKED_CLASSES.includes(mailingClass)) return null;
  let events = { status: [], imb: [] };
  try { events = JSON.parse(track?.events_json ?? EMPTY_EVENTS); } catch { /* Keep empty. */ }
  const number = track?.tracking_number ?? null;
  return {
    mailingClass,
    trackingNumber: number,
    trackingUrl: number ? `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(number)}` : null,
    imbStatus: track?.imb_status ?? null,
    imbDate: track?.imb_date ?? null,
    imbZIPCode: track?.imb_zip ?? null,
    statusEvents: events.status ?? [],
    imbEvents: events.imb ?? [],
    checkedAt: track?.checked_at ?? null,
    returnReceiptRequested: mailingClass === 'certified_return_receipt',
    returnReceipt: track?.receipt_key ? { url: `/api/transmissions/${transmissionId}/mail/${row.id}/receipt`, sha256: track.receipt_sha256, uploadedAt: track.receipt_uploaded_at } : null,
  };
}
