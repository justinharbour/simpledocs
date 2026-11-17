// Accepts "(213) 414-7728", "213.414.7728", "1 213 414 7728", "+1 (213) 414-7728", "+44 20 7946 0958".
// Returns E.164 or null. Bare 10-digit and 11-digit "1…" numbers are treated as NANP.
export function normalizePhone(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!/^\+?[\d\s().-]+$/.test(s)) return null;
  const digits = s.replace(/\D/g, '');
  if (s.startsWith('+')) return /^[1-9]\d{6,14}$/.test(digits) ? `+${digits}` : null;
  if (/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return `+1${digits}`;
  if (/^1[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return `+${digits}`;
  return null;
}
