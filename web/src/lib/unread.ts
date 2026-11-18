import { alertUser, setUnreadTitle } from "@/lib/notify";

export type Counts = { unread: number; byKind: Record<"fax" | "voicemail" | "call" | "sms", number> };
const EVENT = "inbox:count";
// Unread faxes and voicemails at the previous count; the first count after load is only a baseline.
let arrivals: number | null = null;

function show(counts: Counts) {
  setUnreadTitle(counts.unread);
  for (const badge of document.querySelectorAll<HTMLElement>("[data-inbox-badge]")) {
    badge.hidden = counts.unread === 0;
    const number = badge.querySelector("[data-inbox-count]");
    if (number) number.textContent = counts.unread > 99 ? "99+" : String(counts.unread);
  }
  window.dispatchEvent(new CustomEvent<Counts>(EVENT, { detail: counts }));
}

export async function refreshCount(): Promise<Counts | null> {
  try {
    const response = await fetch("/api/inbox/count", { cache: "no-store" });
    if (!response.ok) return null;
    const counts = (await response.json()) as Counts;
    show(counts);
    const now = counts.byKind.fax + counts.byKind.voicemail;
    if (arrivals !== null && now > arrivals) alertUser("New in your inbox", `${now - arrivals} new fax or voicemail.`, { tag: "inbox", href: "/" });
    arrivals = now;
    return counts;
  } catch { return null; }
}

export const onCount = (listener: (counts: Counts) => void) => window.addEventListener(EVENT, (event) => listener((event as CustomEvent<Counts>).detail));

// Fetch on load and about every 30 s while the tab is visible.
export function watchCount() {
  void refreshCount();
  setInterval(() => { if (!document.hidden) void refreshCount(); }, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void refreshCount(); });
}
