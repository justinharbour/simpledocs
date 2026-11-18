import { h, toast } from "@/lib/ui";
import { button } from "@/components/starwind/button/variants";

// Browser notifications are asked for only from an explicit button, never on load.
const supported = () => typeof Notification !== "undefined";

// Shows a notification while the tab is hidden and a toast while it is visible.
export function alertUser(title: string, body: string, options: { tag?: string; href?: string } = {}) {
  if (!document.hidden) return toast(`${title}: ${body}`, "info");
  if (!supported() || Notification.permission !== "granted") return;
  const note = new Notification(title, { body, tag: options.tag });
  note.onclick = () => {
    window.focus();
    if (options.href) window.location.href = options.href;
    note.close();
  };
}

// A button while permission is undecided, a short note if the browser blocks it, nothing otherwise.
export function notifyControl(label: string): HTMLElement {
  const box = h("div", "text-sm");
  const render = () => {
    box.replaceChildren();
    if (!supported() || Notification.permission === "granted") return;
    if (Notification.permission === "denied") return void box.append(h("p", "text-muted-foreground", "Notifications are blocked for this site in your browser settings."));
    const ask = h("button", button({ variant: "outline", size: "sm" }), label);
    ask.type = "button";
    ask.addEventListener("click", () => { void Notification.requestPermission().then(render); });
    box.append(ask);
  };
  render();
  return box;
}

// The tab title carries a transient flag (such as a ringing call) and the unread count.
const base = document.title.replace(/^\(\d+\) /, "");
let unread = 0;
let flag = "";
const render = () => { document.title = `${flag ? `${flag} · ` : ""}${unread > 0 ? `(${unread}) ` : ""}${base}`; };
export function setUnreadTitle(count: number) { unread = count; render(); }
export function setTitleFlag(text: string) { flag = text; render(); }
