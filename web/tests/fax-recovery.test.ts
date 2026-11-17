import { expect, it, vi } from 'vitest';
import { discoverUnresolved } from '../src/lib/fax-recovery';

it('discovers unresolved sends after reload and fails closed on invalid responses', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ intents: [{ id: '11111111-1111-4111-8111-111111111111', status: 'accepted' }] }));
  expect(await discoverUnresolved(fetcher)).toEqual([{ id: '11111111-1111-4111-8111-111111111111', status: 'accepted' }]);
  expect(fetcher).toHaveBeenCalledWith('/api/faxes/unresolved', { cache: 'no-store' });
  expect(await discoverUnresolved(vi.fn().mockResolvedValue(Response.json({ intents: [] })))).toEqual([]);
  await expect(discoverUnresolved(vi.fn().mockResolvedValue(new Response('', { status: 503 })))).rejects.toThrow();
  await expect(discoverUnresolved(vi.fn().mockResolvedValue(Response.json({ intents: [{ id: '../bad', status: 'unknown' }] })))).rejects.toThrow();
});
