// A single provider attempt only. The caller must atomically persist a unique
// send intent before invoking this function and must never retry an unknown
// outcome without reconciling with Telnyx and obtaining user confirmation.
const E164 = /^\+[1-9]\d{1,14}$/;

export async function submitFax({ token, connectionId, from, to, mediaName, intentId }, fetcher = fetch) {
  if (typeof token !== 'string' || !token.trim() || typeof connectionId !== 'string' || !connectionId.trim() ||
      !E164.test(from ?? '') || !E164.test(to ?? '') ||
      typeof mediaName !== 'string' || !mediaName.trim() || mediaName.length > 255 ||
      typeof intentId !== 'string' || !/^[0-9a-f-]{36}$/i.test(intentId)) {
    throw new TypeError('Invalid fax submission configuration');
  }
  const payload = {
    connection_id: connectionId, from, to, media_name: mediaName,
    client_state: btoa(intentId),
  };
  let response;
  try {
    response = await fetcher('https://api.telnyx.com/v2/faxes', {
      method: 'POST', redirect: 'manual',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    return { outcome: 'unknown' };
  }
  // A definitive client rejection excludes timeout, conflict, and rate-limit
  // responses, where acceptance or retry semantics may be ambiguous.
  if (response.status >= 400 && response.status < 500 && ![408, 409, 425, 429].includes(response.status)) {
    return { outcome: 'rejected' };
  }
  if (!response.ok) return { outcome: 'unknown' };
  try {
    const body = await response.json();
    const id = body?.data?.id;
    if (typeof id !== 'string' || !id.trim() || id.length > 256) return { outcome: 'unknown' };
    return { outcome: 'accepted', providerId: id };
  } catch {
    return { outcome: 'unknown' };
  }
}
