// Mirror of worker/phone.mjs. Returns E.164 or null.
export function normalizePhone(input: string): string | null {
  const s = input.trim();
  if (!/^\+?[\d\s().-]+$/.test(s)) return null;
  const digits = s.replace(/\D/g, "");
  if (s.startsWith("+")) return /^[1-9]\d{6,14}$/.test(digits) ? `+${digits}` : null;
  if (/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return `+1${digits}`;
  if (/^1[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return `+${digits}`;
  return null;
}
