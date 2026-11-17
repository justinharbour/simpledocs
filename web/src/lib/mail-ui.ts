export {};
const form = document.querySelector<HTMLFormElement>('#mail-form')!;
const fields = document.querySelector<HTMLFieldSetElement>('#mail-fields')!;
const message = document.querySelector<HTMLElement>('#mail-message')!;
const idLabel = document.querySelector<HTMLElement>('#mail-id')!;
const reviewSection = document.querySelector<HTMLElement>('#mail-review')!;
const preview = document.querySelector<HTMLElement>('#mail-preview')!;
const payloadView = document.querySelector<HTMLElement>('#mail-payload')!;
const confirmation = document.querySelector<HTMLInputElement>('#mail-confirm')!;
const send = document.querySelector<HTMLButtonElement>('#mail-send')!;
const edit = document.querySelector<HTMLButtonElement>('#mail-edit')!;
const check = document.querySelector<HTMLButtonElement>('#mail-check')!;
const newLetter = document.querySelector<HTMLButtonElement>('#mail-new')!;
const reviewButton = document.querySelector<HTMLButtonElement>('#mail-review-button')!;
const unresolvedSection = document.querySelector<HTMLElement>('#mail-unresolved')!;
const unresolvedList = document.querySelector<HTMLElement>('#mail-unresolved-list')!;
const refreshUnresolved = document.querySelector<HTMLButtonElement>('#mail-refresh-unresolved')!;
const key = 'simpledocs-mail-draft-id';
let id = sessionStorage.getItem(key) || crypto.randomUUID();
sessionStorage.setItem(key, id);
let revision = 0;
let reviewed: { revision: number; reviewHash: string } | null = null;
let locked = false;
const url = () => `/api/mail-drafts/${id}`;
idLabel.textContent = `Draft ID: ${id}. Keep this ID if you need help checking an order.`;

function statusText(status: string) {
  if (status === 'accepted') return 'Accepted by PostGrid. This is not confirmation of printing or delivery. Do not send again.';
  return 'The order may have been created. Do not send again. Contact the operator to reconcile this draft ID with PostGrid.';
}
function lock(text: string) {
  locked = true; fields.disabled = true; send.disabled = true; edit.disabled = true;
  reviewSection.hidden = true; check.hidden = false; message.textContent = text;
}
async function checkUnresolved() {
  try {
    const response = await fetch('/api/mail-unresolved', { cache: 'no-store' });
    if (!response.ok) throw new Error();
    const result = await response.json();
    if (!Array.isArray(result.orders)) throw new Error();
    unresolvedList.replaceChildren();
    for (const order of result.orders) {
      const item = document.createElement('li');
      item.textContent = `Draft ${order.draft_id} — ${order.status} — confirmed ${order.confirmed_at}${order.provider_id ? ` — PostGrid ID: ${order.provider_id}` : ''}`;
      if (order.status === 'accepted' && typeof order.provider_id === 'string') {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'mt-2 block rounded-md border border-input px-4 py-2';
        button.textContent = 'Acknowledge accepted order';
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            const response = await fetch(`/api/mail-drafts/${encodeURIComponent(order.draft_id)}/acknowledge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acknowledged: true, providerId: order.provider_id }) });
            if (!response.ok) throw new Error();
            if (!await checkUnresolved()) location.reload();
          } catch { message.textContent = 'Acknowledgement could not be confirmed. Refresh the list before taking further action.'; button.disabled = false; }
        });
        item.append(button);
      }
      unresolvedList.append(item);
    }
    unresolvedSection.hidden = result.orders.length === 0;
    if (result.orders.length) { newLetter.hidden = true; lock('An order requiring attention blocks new mail. Acknowledge an accepted order or contact the operator about an uncertain order.'); return true; }
    return false;
  } catch {
    unresolvedSection.hidden = false; newLetter.hidden = true;
    lock('Unresolved orders could not be checked. Do not send until the operator confirms the outcome.');
    return true;
  }
}
async function checkStatus() {
  try {
    const response = await fetch(`${url()}/status`, { cache: 'no-store' });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error();
    const result = await response.json();
    lock(`${statusText(result.status)}${result.provider_id ? ` PostGrid ID: ${result.provider_id}.` : ''}`);
    newLetter.hidden = result.status !== 'accepted' || !result.acknowledged_at;
    return true;
  } catch {
    lock('Status is unavailable. Do not send again until the operator confirms the outcome.');
    return true;
  }
}
function contentFromForm() {
  const data = new FormData(form);
  const contact = (prefix: string) => Object.fromEntries(['firstName', 'lastName', 'addressLine1', 'addressLine2', 'city', 'provinceOrState', 'postalOrZip'].map(k => [k, String(data.get(`${prefix}.${k}`) || '')]).filter(([, value]) => value !== '').concat([['countryCode', 'US']]));
  return { to: contact('to'), from: contact('from'), text: String(data.get('text') || ''), mailingClass: String(data.get('mailingClass')), color: data.has('color'), doubleSided: data.has('doubleSided') };
}
function restore(content: Record<string, any>) {
  for (const party of ['to', 'from']) for (const [name, value] of Object.entries(content[party] || {})) {
    const input = form.elements.namedItem(`${party}.${name}`);
    if (input instanceof HTMLInputElement && typeof value === 'string') input.value = value;
  }
  for (const name of ['text', 'mailingClass']) {
    const input = form.elements.namedItem(name);
    if ((input instanceof HTMLTextAreaElement || input instanceof HTMLSelectElement) && typeof content[name] === 'string') input.value = content[name];
  }
  for (const name of ['color', 'doubleSided']) {
    const input = form.elements.namedItem(name);
    if (input instanceof HTMLInputElement) input.checked = content[name] === true;
  }
}
async function initialize() {
  fields.disabled = true;
  if (await checkUnresolved()) return;
  if (await checkStatus()) return;
  try {
    const response = await fetch(url(), { cache: 'no-store' });
    if (response.ok) { const draft = await response.json(); revision = draft.revision; restore(draft.content); }
    else if (response.status !== 404) throw new Error();
    fields.disabled = false;
  } catch { lock('Draft storage is unavailable. Do not send again until the operator confirms the outcome.'); }
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (locked) return;
  const content = contentFromForm(); reviewButton.disabled = true; message.textContent = 'Saving draft and preparing review…';
  if (/[{}&]/u.test(content.text)) { message.textContent = 'Remove braces and ampersands from the letter text before review; they may be interpreted as template syntax.'; reviewButton.disabled = false; return; }
  try {
    const saved = await fetch(url(), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision, content }) });
    if (!saved.ok) throw new Error('Could not save the draft. Reload to check its latest revision.');
    revision = (await saved.json()).revision;
    const response = await fetch(`${url()}/review`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Could not prepare the review. Check the letter and try again.');
    const result = await response.json();
    if (result.revision !== revision) throw new Error('The draft changed. Reload before reviewing.');
    reviewed = { revision: result.revision, reviewHash: result.reviewHash };
    // Use textContent: provider input is untrusted and must never become active markup.
    preview.textContent = content.text;
    payloadView.textContent = JSON.stringify(result.payload, null, 2);
    confirmation.checked = false; send.disabled = true; reviewSection.hidden = false; fields.disabled = true;
    message.textContent = 'Review the saved letter and exact request before authorizing the paid order.';
    document.querySelector<HTMLElement>('#review-heading')!.focus();
  } catch (error) {
    reviewed = null; lock(error instanceof Error ? `${error.message} Reload this page to check the draft and order status.` : 'Unable to save or review. Reload to check the draft and order status.');
  }
  reviewButton.disabled = false;
});
confirmation.addEventListener('change', () => { send.disabled = !confirmation.checked || !reviewed || locked; });
edit.addEventListener('click', () => { reviewed = null; confirmation.checked = false; send.disabled = true; reviewSection.hidden = true; fields.disabled = false; message.textContent = 'Edit the letter, then save and review it again.'; });
send.addEventListener('click', async () => {
  if (!reviewed || !confirmation.checked || locked) return;
  const authorization = { ...reviewed, confirmed: true };
  // Persist the ID before sending. Never create a new one or retry after uncertainty.
  lock('Submitting the order. Do not send it again while the outcome is being checked.');
  try {
    const response = await fetch(`${url()}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(authorization) });
    if (!response.ok) { if (!await checkUnresolved() && !await checkStatus()) lock('The order was not confirmed. Check status and contact the operator before trying again.'); return; }
    const result = await response.json();
    lock(`${statusText(result.status)}${result.providerId ? ` PostGrid ID: ${result.providerId}.` : ''}`);
    newLetter.hidden = true;
  } catch { lock('The send outcome is unknown. Do not send again. Check status and contact the operator.'); }
  await checkUnresolved();
});
check.addEventListener('click', async () => {
  check.disabled = true;
  const found = await checkUnresolved() || await checkStatus();
  if (!found) lock('No submission record was found. Do not send again until the operator confirms the outcome.');
  check.disabled = false;
});
refreshUnresolved.addEventListener('click', async () => {
  refreshUnresolved.disabled = true;
  if (!await checkUnresolved()) location.reload();
  refreshUnresolved.disabled = false;
});
newLetter.addEventListener('click', () => {
  // This never resets an existing claim. The next letter gets a new identifier.
  sessionStorage.setItem(key, crypto.randomUUID());
  location.reload();
});
void initialize();
