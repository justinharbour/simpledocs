import { alert } from "@/components/starwind/alert/variants";
import { api, channelLabels, h, isTerminal, postJson, statusBadge, statusLabel, when } from "@/lib/ui";

export type Delivery = {
  id: string;
  channel: "fax" | "mail";
  recipient: string;
  status: string;
  providerStatus: string | null;
  error: string | null;
  needsApproval: boolean;
  coverUrl: string | null;
  timeline: { at: string; status: string; detail: string | null }[];
};
export type Detail = {
  id: string;
  title: string;
  pageCount: number;
  createdAt: string;
  updatedAt: string;
  documentUrl: string;
  settled: boolean;
  deliveries: Delivery[];
};

// The confirmation page is the approval. The worker still checks the review
// hash and the test/live key before anything is put on the queue.
export async function approveLetter(transmissionId: string, deliveryId: string, mode: "test" | "live") {
  const base = `/api/transmissions/${transmissionId}/mail/${deliveryId}`;
  const review = await api<{ reviewHash: string; available: boolean }>(`${base}/review?mode=${mode}`);
  if (!review.available) throw new Error(`Paper mail in ${mode} mode is not set up on this instance.`);
  await postJson(`${base}/approve`, { confirmed: true, mode, reviewHash: review.reviewHash });
}

function timeline(delivery: Delivery): HTMLElement {
  const list = h("ol", "border-border mt-3 flex flex-col gap-2 border-l pl-4 text-sm");
  for (const step of delivery.timeline) {
    const item = h("li", "flex flex-wrap items-baseline gap-x-2");
    item.append(h("span", "font-medium", statusLabel(step.status)));
    if (step.detail && step.detail !== step.status) item.append(h("span", "text-muted-foreground", step.detail));
    item.append(h("span", "text-muted-foreground ml-auto text-xs", when(step.at)));
    list.append(item);
  }
  return list;
}

function note(delivery: Delivery): string {
  if (delivery.needsApproval) return "This letter was not confirmed, so nothing was mailed. Start again from Send.";
  if (delivery.status === "queued") return "Waiting its turn. It has not been sent yet.";
  if (delivery.status === "accepted" && delivery.channel === "fax") return "Telnyx has the fax. It is not delivered until the receiving machine confirms.";
  if (delivery.status === "accepted") return "PostGrid has the letter. It is not printed or mailed yet.";
  if (delivery.status === "completed") return "PostGrid reports the letter as completed. That is not a delivery confirmation.";
  return "";
}

function row(delivery: Delivery): HTMLElement {
  const card = h("div", "border-border rounded-lg border p-4");
  const top = h("div", "flex flex-wrap items-center justify-between gap-2");
  const who = h("div", "flex flex-col");
  who.append(h("span", "font-medium", channelLabels[delivery.channel]), h("span", "text-muted-foreground text-sm", delivery.recipient));
  top.append(who, statusBadge(delivery.status));
  card.append(top);
  const hint = note(delivery);
  if (hint) card.append(h("p", "text-muted-foreground mt-2 text-sm", hint));
  if (delivery.providerStatus) card.append(h("p", "text-muted-foreground mt-1 text-xs", `Provider status: ${delivery.providerStatus}`));
  if (delivery.error) card.append(h("div", alert({ variant: "error", class: "mt-3 p-3 text-sm" }), delivery.error));
  if (delivery.coverUrl) {
    const link = h("a", "mt-3 inline-block text-sm underline underline-offset-4", "View cover page");
    link.href = delivery.coverUrl; link.target = "_blank"; link.rel = "noopener";
    card.append(link);
  }
  card.append(timeline(delivery));
  return card;
}

function info(detail: Detail): DocumentFragment {
  const frag = document.createDocumentFragment();
  const head = h("div", "flex flex-wrap items-baseline justify-between gap-2");
  head.append(h("h3", "text-lg font-semibold", detail.title), h("span", "text-muted-foreground text-sm", `${detail.pageCount} ${detail.pageCount === 1 ? "page" : "pages"}`));
  frag.append(head, h("p", "text-muted-foreground mt-1 text-sm", `Created ${when(detail.createdAt)} · last change ${when(detail.updatedAt)}`));
  const list = h("div", "mt-4 flex flex-col gap-3");
  for (const delivery of detail.deliveries) list.append(row(delivery));
  frag.append(list);
  if (!detail.settled) frag.append(h("p", "text-muted-foreground mt-3 text-sm", "Checking for updates every few seconds."));
  return frag;
}

// Shows the envelope and keeps it fresh until every channel is in a terminal state.
// The PDF preview is built once so polling never reloads it.
export function watchTransmission(target: HTMLElement, id: string, withPreview = true): () => void {
  const body = h("div");
  const preview = h("div", "mt-4");
  target.replaceChildren(body, preview);
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, loaded = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const detail = await api<Detail>(`/api/transmissions/${id}`);
      if (stopped) return;
      body.replaceChildren(info(detail));
      if (!loaded && withPreview) {
        const frame = h("iframe", "border-border h-[28rem] w-full rounded-lg border");
        frame.src = detail.documentUrl; frame.title = `Preview of ${detail.title}`;
        const link = h("a", "mt-2 inline-block text-sm underline underline-offset-4", "Open the PDF in a new tab");
        link.href = detail.documentUrl; link.target = "_blank"; link.rel = "noopener";
        preview.append(frame, link);
      }
      loaded = true;
      if (detail.deliveries.every((d) => isTerminal(d.status) || d.needsApproval)) return;
    } catch {
      if (!loaded) body.replaceChildren(h("div", alert({ variant: "error", class: "p-3 text-sm" }), "Could not load this record. Try again in a moment."));
    }
    timer = setTimeout(tick, 4000);
  };
  void tick();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
