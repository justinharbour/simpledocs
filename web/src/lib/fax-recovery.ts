const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export async function discoverUnresolved(fetcher: typeof fetch) {
  const response = await fetcher('/api/faxes/unresolved', { cache: 'no-store' });
  if (!response.ok) throw new Error('Status unavailable');
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || !('intents' in body) || !Array.isArray(body.intents)) throw new Error('Invalid status');
  return body.intents.map((item: unknown) => {
    if (!item || typeof item !== 'object' || !('id' in item) || typeof item.id !== 'string' || !uuid.test(item.id) || !('status' in item) || !['accepted', 'submitting', 'unknown'].includes(String(item.status))) throw new Error('Invalid intent');
    return { id: item.id, status: String(item.status) };
  });
}
