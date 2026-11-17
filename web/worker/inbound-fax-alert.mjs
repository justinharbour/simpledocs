// Never include fax identifiers, numbers, URLs or content in alerts or logs.
import { claimFaxAlertInterval } from './inbound-fax-alert-pacing.mjs';

export async function sendPendingFaxAlert(env, { now = Date.now() } = {}) {
  if (env.FAX_ALERTS_ENABLED !== 'true') return 'disabled';
  const threshold = Number(env.FAX_ALERT_AFTER_SECONDS);
  const recipient = env.FAX_ALERT_RECIPIENT;
  const sender = env.FAX_ALERT_SENDER;
  const address = value => typeof value === 'string' && value.length <= 254 && /^[^\s@<>\r\n]+@[^\s@<>\r\n]+\.[^\s@<>\r\n]+$/.test(value);
  if (!Number.isSafeInteger(threshold) || threshold < 60 || threshold > 86400 || !Number.isFinite(now) || !address(recipient) || !address(sender) || !env.DB || typeof env.FAX_ALERT_EMAIL?.send !== 'function') return 'unavailable';
  try {
    const cutoff = new Date(now - threshold * 1000).toISOString();
    const pending = await env.DB.prepare('SELECT COUNT(*) AS count FROM inbound_fax_unarchived WHERE received_at <= ?').bind(cutoff).first();
    if (!Number.isSafeInteger(pending?.count) || pending.count < 0) return 'unavailable';
    if (pending.count === 0) return 'none';
    const interval = Number(env.FAX_ALERT_INTERVAL_SECONDS);
    if (!Number.isSafeInteger(interval) || interval < 60 || interval > 86400) return 'unavailable';
    const claim = await claimFaxAlertInterval(env.DB, { now, intervalMs: interval * 1000 });
    if (claim !== 'claimed') return claim;
    await env.FAX_ALERT_EMAIL.send({
      from: sender, to: recipient, subject: 'Simpledocs: inbound fax needs attention',
      text: 'One or more inbound faxes have not been archived. Sign in to Simpledocs and contact the operator to investigate.',
    });
    // Binding acceptance is not proof of delivery.
    return 'accepted';
  } catch { return 'unavailable'; }
}
