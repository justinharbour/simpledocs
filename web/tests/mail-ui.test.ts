// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const html = readFileSync('dist/mail/index.html', 'utf8');
const draftId = 'ed600156-741d-4fcb-a7b2-388d87883151';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('mail review UI', () => {
  let calls: Array<{ url: string; options?: RequestInit }>;
  beforeEach(() => {
    document.documentElement.innerHTML = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
    sessionStorage.clear(); sessionStorage.setItem('simpledocs-mail-draft-id', draftId);
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
      calls.push({ url, options });
      if (url === '/api/mail-unresolved') return Response.json({ orders: [] });
      if (url.endsWith('/status')) return new Response('', { status: 404 });
      if (options?.method === 'PUT') return Response.json({ revision: 1 });
      if (url.includes('/review?mode=')) return Response.json({ revision: 1, mode: 'test', reviewHash: 'a'.repeat(64), payload: { to: { firstName: 'Example' }, html: '<p>safe &amp; sound</p>', color: false } });
      if (url.endsWith('/send')) return Response.json({ status: 'unknown' });
      return new Response('', { status: 404 });
    }));
    vi.resetModules();
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  it('shows exact request as text, requires explicit confirmation and never repeats an uncertain send', async () => {
    await import('../src/lib/mail-ui'); await tick();
    const form = document.querySelector<HTMLFormElement>('#mail-form')!;
    for (const party of ['to', 'from']) for (const [field, value] of Object.entries({ firstName: 'Example', addressLine1: '1 Main', city: 'Boston', provinceOrState: 'MA', postalOrZip: '02110' })) {
      (form.elements.namedItem(`${party}.${field}`) as HTMLInputElement).value = value;
    }
    (form.elements.namedItem('text') as HTMLTextAreaElement).value = 'safe text';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await tick(); await tick();
    expect(document.querySelector<HTMLElement>('#mail-review')!.hidden).toBe(false);
    expect(calls.some(x => x.url.endsWith('/review?mode=test'))).toBe(true);
    expect(document.querySelector('#mail-review-mode')!.textContent).toContain('TEST MODE');
    expect(document.querySelector('#mail-payload')!.textContent).toContain('<p>safe &amp; sound</p>');
    expect(document.querySelector('#mail-payload p')).toBeNull();
    const send = document.querySelector<HTMLButtonElement>('#mail-send')!;
    expect(send.disabled).toBe(true);
    const confirm = document.querySelector<HTMLInputElement>('#mail-confirm')!;
    confirm.checked = true; confirm.dispatchEvent(new Event('change'));
    expect(send.disabled).toBe(false);
    send.click(); await tick();
    const posts = calls.filter(x => x.url.endsWith('/send'));
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0].options!.body as string)).toEqual({ revision: 1, reviewHash: 'a'.repeat(64), mode: 'test', confirmed: true });
    expect(document.querySelector('#mail-message')!.textContent).toContain('Do not send again');
    send.click(); await tick(); expect(calls.filter(x => x.url.endsWith('/send'))).toHaveLength(1);
  });
  it('locks the form if a prior submission exists', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ orders: [{ draft_id: draftId, status: 'submitting', confirmed_at: '2026-01-01' }] })));
    await import('../src/lib/mail-ui'); await tick();
    expect(document.querySelector<HTMLFieldSetElement>('#mail-fields')!.disabled).toBe(true);
    expect(document.querySelector('#mail-unresolved-list')!.textContent).toContain(draftId);
    expect(document.querySelector('#mail-message')!.textContent).toContain('blocks new mail');
  });
  it('fails closed when the cross-device unresolved list is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw Error('offline'); }));
    await import('../src/lib/mail-ui'); await tick();
    expect(document.querySelector<HTMLFieldSetElement>('#mail-fields')!.disabled).toBe(true);
    expect(document.querySelector('#mail-message')!.textContent).toContain('could not be checked');
  });
  it('recovers an accepted order in a fresh session and requires acknowledgement', async () => {
    sessionStorage.clear();
    const mock = vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.method === 'POST') return Response.json({ acknowledged: true });
      return Response.json({ orders: [{ draft_id: draftId, status: 'accepted', provider_id: 'letter_123', confirmed_at: '2026-01-01' }] });
    });
    vi.stubGlobal('fetch', mock);
    await import('../src/lib/mail-ui'); await tick();
    expect(document.querySelector<HTMLFieldSetElement>('#mail-fields')!.disabled).toBe(true);
    expect(document.querySelector('#mail-unresolved-list')!.textContent).toContain('letter_123');
    const button = document.querySelector<HTMLButtonElement>('#mail-unresolved-list button')!;
    expect(button.textContent).toContain('Acknowledge'); button.click(); await tick();
    const post = mock.mock.calls.find(([, options]) => options?.method === 'POST');
    expect(post?.[0]).toContain(`${draftId}/acknowledge`);
    expect(JSON.parse(post![1]!.body as string)).toEqual({ acknowledged: true, providerId: 'letter_123' });
  });
  it('rejects template characters before saving a draft', async () => {
    await import('../src/lib/mail-ui'); await tick();
    const form = document.querySelector<HTMLFormElement>('#mail-form')!;
    (form.elements.namedItem('text') as HTMLTextAreaElement).value = '{{recipient}}';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await tick();
    expect(calls.some(x => x.options?.method === 'PUT')).toBe(false);
    expect(document.querySelector('#mail-message')!.textContent).toContain('Remove braces');
  });
});
