import { api, h, postJson, skeletonRows, toast, when } from "@/lib/ui";
import { icon } from "@/lib/icons";
import { alertUser } from "@/lib/notify";
import { refreshCount } from "@/lib/unread";
import { button } from "@/components/starwind/button/variants";
import { textarea } from "@/components/starwind/textarea/variants";

export type Message = {
  id: string; direction: "inbound" | "outbound"; peer: string; body: string; status: string;
  errorCode: string | null; errorText: string | null; createdAt: string; statusAt: string; readAt: string | null;
};
type Pending = { localId: string; body: string; failed: boolean; error: string };

// What Telnyx last reported. "Sending" means accepted for sending, not delivered.
const STATUS: Record<string, string> = {
  queued: "Queued", sending: "Sending", sent: "Sent to carrier", delivered: "Delivered",
  unconfirmed: "Sent, delivery not confirmed", failed: "Failed", received: "Received",
};
export const statusText = (status: string) => STATUS[status] ?? status;

const GSM = /^[A-Za-z0-9 \r\n@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]*$/;
export function segments(text: string): { length: number; parts: number; limit: number } {
  const gsm = GSM.test(text);
  const length = text.length;
  const single = gsm ? 160 : 70, multi = gsm ? 153 : 67;
  return { length, parts: length === 0 ? 0 : length <= single ? 1 : Math.ceil(length / multi), limit: single };
}

const tail = (peer: string) => peer;
export const threadHref = (peer: string) => `/messages/?peer=${encodeURIComponent(peer)}`;

// A conversation with one number: bubbles, a composer, polling while visible, and optimistic sends.
export function createThread(peer: string, hooks: { onChange?: () => void } = {}) {
  const root = h("div", "flex h-full min-h-0 flex-col");
  const log = h("div", "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto py-4");
  log.setAttribute("role", "log");
  log.setAttribute("aria-label", `Messages with ${tail(peer)}`);
  log.tabIndex = 0;
  const form = h("form", "border-border flex flex-col gap-2 border-t pt-3");
  const input = h("textarea", textarea({ size: "md", class: "min-h-20 resize-none" }));
  input.id = `compose-${Math.random().toString(36).slice(2)}`;
  input.rows = 2; input.maxLength = 1600; input.placeholder = "Write a message";
  input.setAttribute("aria-label", "Message");
  const counter = h("p", "text-muted-foreground text-xs");
  counter.id = `${input.id}-count`;
  input.setAttribute("aria-describedby", counter.id);
  const send = h("button", button({ variant: "primary", size: "md" }));
  send.type = "submit"; send.append(icon("send"), document.createTextNode("Send"));
  const row = h("div", "flex items-center justify-between gap-3");
  row.append(counter, send);
  form.append(input, row);
  root.append(log, form);

  let messages: Message[] = [];
  let pending: Pending[] = [];
  let loaded = false, failedLoad = false, stopped = false;
  let signature = "";
  const seen = new Set<string>();

  const count = () => {
    const s = segments(input.value);
    counter.textContent = s.length === 0 ? "Enter sends, Shift+Enter adds a line." : `${s.length} characters, ${s.parts} ${s.parts === 1 ? "segment" : "segments"} (${s.limit} per segment)`;
    send.disabled = input.value.trim().length === 0;
  };

  function bubble(text: string, outbound: boolean) {
    const wrap = h("div", `flex max-w-[85%] flex-col gap-1 ${outbound ? "items-end self-end" : "items-start self-start"}`);
    const body = h("p", `rounded-2xl px-4 py-2 text-base break-words whitespace-pre-wrap ${outbound ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"}`, text);
    wrap.append(body);
    return wrap;
  }
  function note(wrap: HTMLElement, text: string, failed: boolean) {
    const line = h("p", `flex items-center gap-1 text-xs ${failed ? "text-error" : "text-muted-foreground"}`);
    if (failed) line.append(icon("alertCircle", "size-3.5"));
    line.append(document.createTextNode(text));
    wrap.append(line);
    return line;
  }
  function retry(wrap: HTMLElement, body: string, drop: () => void) {
    const again = h("button", button({ variant: "outline", size: "sm" }), "Retry");
    again.type = "button";
    again.addEventListener("click", () => { drop(); void submit(body); });
    wrap.append(again);
  }

  function render(force = false) {
    const sig = `${loaded}${failedLoad}${messages.map(m => `${m.id}:${m.status}`).join(",")}|${pending.map(p => `${p.localId}:${p.failed}`).join(",")}`;
    if (!force && sig === signature) return;
    signature = sig;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    log.replaceChildren();
    if (!loaded) { log.append(failedLoad ? h("p", "text-muted-foreground m-auto text-sm", "Messages could not be loaded.") : skeletonRows(3, "h-12 w-2/3")); }
    else if (!messages.length && !pending.length) log.append(h("p", "text-muted-foreground m-auto text-sm", "No messages yet. Write the first one below."));
    for (const m of messages) {
      const wrap = bubble(m.body, m.direction === "outbound");
      const stamp = when(m.direction === "outbound" ? m.statusAt : m.createdAt);
      if (m.direction === "inbound") note(wrap, stamp, false);
      else {
        const failed = m.status === "failed";
        note(wrap, failed ? `Failed${m.errorText ? `: ${m.errorText}` : ""}${m.errorCode ? ` (code ${m.errorCode})` : ""} · ${stamp}` : `${statusText(m.status)} · ${stamp}`, failed);
        if (failed) retry(wrap, m.body, () => {});
      }
      log.append(wrap);
    }
    for (const p of pending) {
      const wrap = bubble(p.body, true);
      note(wrap, p.failed ? `Not sent: ${p.error}` : "Sending…", p.failed);
      if (p.failed) retry(wrap, p.body, () => { pending = pending.filter(x => x !== p); render(); });
      log.append(wrap);
    }
    if (nearBottom || force) log.scrollTop = log.scrollHeight;
  }

  async function markRead() {
    try { await postJson(`/api/sms/threads/${encodeURIComponent(peer)}/read`, {}); void refreshCount(); hooks.onChange?.(); } catch { /* the next poll tries again */ }
  }

  async function load() {
    try {
      const data = await api<{ messages: Message[] }>(`/api/sms/threads/${encodeURIComponent(peer)}`);
      const first = !loaded;
      const fresh = data.messages.filter(m => m.direction === "inbound" && !seen.has(m.id));
      for (const m of data.messages) seen.add(m.id);
      messages = data.messages; loaded = true; failedLoad = false;
      render(first);
      const unread = data.messages.some(m => m.direction === "inbound" && !m.readAt);
      if (unread && !document.hidden) void markRead();
      if (!first && fresh.length) alertUser(`New message from ${peer}`, fresh[fresh.length - 1].body.slice(0, 100), { tag: peer, href: threadHref(peer) });
    } catch { if (!loaded) { failedLoad = true; render(true); } }
  }

  async function submit(body: string) {
    const entry: Pending = { localId: crypto.randomUUID(), body, failed: false, error: "" };
    pending = [...pending, entry]; render(true);
    try {
      const { message } = await postJson<{ message: Message }>("/api/sms/messages", { to: peer, text: body });
      pending = pending.filter(p => p !== entry);
      messages = [...messages.filter(m => m.id !== message.id), message]; seen.add(message.id);
      render(true); hooks.onChange?.();
    } catch (error) {
      entry.failed = true; entry.error = error instanceof Error ? error.message : "Try again.";
      render(true);
    }
  }

  input.addEventListener("input", count);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const body = input.value;
    if (!body.trim()) return;
    input.value = ""; count();
    void submit(body);
  });
  count(); render(true);
  void load();
  const timer = setInterval(() => { if (!document.hidden && !stopped) void load(); }, 5000);
  const resume = () => { if (!document.hidden && !stopped) void load(); };
  document.addEventListener("visibilitychange", resume);
  return {
    el: root,
    focus: () => input.focus(),
    stop() { stopped = true; clearInterval(timer); document.removeEventListener("visibilitychange", resume); },
  };
}

export function tellFailure(error: unknown) { toast(error instanceof Error ? error.message : "Something went wrong.", "error"); }
