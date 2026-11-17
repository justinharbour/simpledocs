const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loadInbox(fetcher: typeof fetch) {
  const response = await fetcher('/api/inbound-faxes', { headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (!response.ok) throw new Error('Inbox unavailable');
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || !('records' in body) || !Array.isArray(body.records) || body.records.length > 100) throw new Error('Invalid inbox response');
  if (!('pendingCount' in body) || typeof body.pendingCount !== 'number' || !Number.isSafeInteger(body.pendingCount) || body.pendingCount < 0) throw new Error('Invalid inbox response');
  const records = body.records.map((record: unknown) => {
    if (!record || typeof record !== 'object' || !('id' in record) || typeof record.id !== 'string' || !uuid.test(record.id) || !('receivedAt' in record) || typeof record.receivedAt !== 'string') throw new Error('Invalid inbox record');
    const date = new Date(record.receivedAt);
    if (!Number.isFinite(date.getTime())) throw new Error('Invalid inbox date');
    return { downloadPath: `/api/inbound-faxes/${record.id}/pdf`, receivedLabel: date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) };
  });
  return { records, pendingCount: body.pendingCount };
}
