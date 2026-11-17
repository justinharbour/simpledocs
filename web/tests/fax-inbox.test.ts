import { describe, expect, it, vi } from 'vitest';
import { loadInbox } from '../src/lib/fax-inbox';

describe('fax inbox', () => {
  it('loads real records and creates same-origin downloads', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ pendingCount: 2, records: [{ id: '11111111-1111-4111-8111-111111111111', receivedAt: '2026-11-17T12:00:00Z' }] }));
    const { records, pendingCount } = await loadInbox(fetcher);
    expect(pendingCount).toBe(2);
    expect(fetcher).toHaveBeenCalledWith('/api/inbound-faxes', expect.objectContaining({ cache: 'no-store' }));
    expect(records[0].downloadPath).toBe('/api/inbound-faxes/11111111-1111-4111-8111-111111111111/pdf');
    expect(records[0].receivedLabel).toBeTruthy();
  });
  it('returns empty and rejects failed or malformed responses', async () => {
    expect(await loadInbox(vi.fn().mockResolvedValue(Response.json({ records: [], pendingCount: 0 })))).toEqual({ records: [], pendingCount: 0 });
    await expect(loadInbox(vi.fn().mockResolvedValue(Response.json({ records: [] })))).rejects.toThrow();
    await expect(loadInbox(vi.fn().mockResolvedValue(new Response('', { status: 403 })))).rejects.toThrow();
    await expect(loadInbox(vi.fn().mockResolvedValue(Response.json({ pendingCount: 0, records: [{ id: '../evil', receivedAt: 'today' }] })))).rejects.toThrow();
  });
});
