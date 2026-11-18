import { alert } from "@/components/starwind/alert/variants";
import { badge } from "@/components/starwind/badge/variants";
import { skeleton } from "@/components/starwind/skeleton/variants";

type BadgeVariant = "secondary" | "info" | "success" | "warning" | "error" | "outline" | "ghost";

// "accepted" and "completed" are what a provider said, never proof of delivery.
const statuses: Record<string, { label: string; variant: BadgeVariant }> = {
  awaiting_approval: { label: "Awaiting confirmation", variant: "warning" },
  queued: { label: "Queued", variant: "secondary" },
  submitting: { label: "Submitting", variant: "secondary" },
  accepted: { label: "Accepted by provider", variant: "info" },
  delivered: { label: "Delivered", variant: "success" },
  completed: { label: "Completed by PostGrid", variant: "info" },
  failed: { label: "Failed", variant: "error" },
  unknown: { label: "Outcome unknown", variant: "warning" },
  revoked: { label: "Access revoked", variant: "secondary" },
  received: { label: "Received", variant: "success" },
  heard: { label: "Heard", variant: "ghost" },
  unheard: { label: "New", variant: "info" },
};

export const channelLabels: Record<string, string> = { fax: "Fax", mail: "Paper mail", email: "Email", voice: "Voicemail" };
export const isTerminal = (status: string) => ["delivered", "completed", "failed"].includes(status);
export const statusLabel = (status: string) => statuses[status]?.label ?? status;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function badgeEl(text: string, variant: BadgeVariant = "outline"): HTMLElement {
  return h("span", badge({ variant, size: "sm" }), text);
}

export function statusBadge(status: string, channel?: string): HTMLElement {
  const known = statuses[status];
  const prefix = channel ? `${channelLabels[channel] ?? channel}: ` : "";
  return badgeEl(`${prefix}${known?.label ?? status}`, known?.variant ?? "outline");
}

export function skeletonRows(count = 4, className = "h-12 w-full"): HTMLElement {
  const wrap = h("div", "flex flex-col gap-2");
  wrap.setAttribute("aria-hidden", "true");
  for (let i = 0; i < count; i++) wrap.append(h("div", skeleton({ class: className })));
  return wrap;
}

export function when(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? `${value.replace(" ", "T")}Z` : value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
}

// "5 min ago" for recent times, otherwise the short date. Pair it with `when` as the exact time.
export function ago(value: string | null | undefined): string {
  const date = new Date(value ?? "");
  if (!Number.isFinite(date.getTime())) return "";
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "";
  const m = Math.floor(seconds / 60), s = seconds % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
}

export function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...init });
  let body: unknown = null;
  try { body = await response.json(); } catch { /* not JSON */ }
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "Something went wrong. Try again.";
    throw new Error(message);
  }
  return body as T;
}

export const postJson = <T>(path: string, body: unknown, method = "POST") =>
  api<T>(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

let region: HTMLElement | null = null;
export function toast(message: string, kind: "success" | "error" | "info" = "info") {
  if (!region) {
    region = h("div", "fixed right-4 bottom-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2");
    region.setAttribute("aria-live", "polite");
    document.body.append(region);
  }
  const node = h("div", alert({ variant: kind === "error" ? "error" : kind === "success" ? "success" : "info", class: "bg-background shadow-lg" }), message);
  node.setAttribute("role", kind === "error" ? "alert" : "status");
  region.append(node);
  setTimeout(() => node.remove(), kind === "error" ? 8000 : 4500);
}
