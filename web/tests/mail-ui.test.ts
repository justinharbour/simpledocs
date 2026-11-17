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
      if (url.endsWith('/status')) return new Response('', { status: 404 });
      if (options?.method === 'PUT') return Response.json({ revision: 1 });
      if (url.endsWith('/review')) return Response.json({ revision: 1, reviewHash: 'a'.repeat(64), payload: { to: { firstName: 'Example' }, html: '<p>safe &amp; sound</p>', color: false } });
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
    (form.elements.namedItem('text') as HTMLTextAreaElement).value = 'safe & sound';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await tick(); await tick();
    expect(document.querySelector<HTMLElement>('#mail-review')!.hidden).toBe(false);
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
    expect(JSON.parse(posts[0].options!.body as string)).toEqual({ revision: 1, reviewHash: 'a'.repeat(64), confirmed: true });
    expect(document.querySelector('#mail-message')!.textContent).toContain('Do not send again');
    send.click(); await tick(); expect(calls.filter(x => x.url.endsWith('/send'))).toHaveLength(1);
  });
  it('locks the form if a prior submission exists', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'submitting' })));
    await import('../src/lib/mail-ui'); await tick();
    expect(document.querySelector<HTMLFieldSetElement>('#mail-fields')!.disabled).toBe(true);
    expect(document.querySelector('#mail-message')!.textContent).toContain('Do not send again');
  });
});
