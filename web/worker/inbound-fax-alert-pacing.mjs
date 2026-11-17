// Internal primitive only: not connected to a scheduler or email sender.
// A claim reserves the whole interval before any external side effect; a crash
// or uncertain send consumes that interval. It is not evidence of delivery.
export async function claimFaxAlertInterval(db, { now, intervalMs }) {
  if (!db || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(intervalMs) || intervalMs < 60000 || intervalMs > 86400000 || !Number.isSafeInteger(now + intervalMs)) return 'unavailable';
  try {
    const result = await db.prepare(`INSERT INTO fax_alert_pacing (channel, next_attempt_ms) VALUES ('email', ?)
      ON CONFLICT(channel) DO UPDATE SET next_attempt_ms = excluded.next_attempt_ms
      WHERE fax_alert_pacing.next_attempt_ms <= ? RETURNING channel`).bind(now + intervalMs, now).first();
    if (result === null) return 'paced';
    return result?.channel === 'email' ? 'claimed' : 'unavailable';
  } catch { return 'unavailable'; }
}
