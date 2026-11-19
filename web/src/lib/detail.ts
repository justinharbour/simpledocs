import { alert } from "@/components/starwind/alert/variants";
import { api, channelLabels, h, isTerminal, mailClassLabels, postJson, statusBadge, statusLabel, when } from "@/lib/ui";

export type Delivery = {
  id: string;
  channel: "fax" | "mail" | "email";
  recipient: string;
  status: string;
  providerStatus: string | null;
  error: string | null;
  needsApproval: boolean;
  coverUrl: string | null;
  canRevoke?: boolean;
  timeline: { at: string; status: string; detail: string | null }[];
  tracking?: Tracking | null;
};
export type Tracking = {
  mailingClass: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  imbStatus: string | null;
  imbDate: string | null;
  imbZIPCode: string | null;
  statusEvents: { status: string; date: string }[];
  imbEvents: { status: string; date: string; zipCode: string | null; scanCode: string | null }[];
  checkedAt: string | null;
  returnReceiptRequested: boolean;
  returnReceipt: { url: string; sha256: string; uploadedAt: string } | null;
};
export type Detail = {
  id: string;
  envelopeNumber?: string | null;
  documents?: { position: number; number: string; name: string; pageCount: number }[];
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

const scanLabels: Record<string, string> = { entered_mail_stream: "Entered the mail stream", out_for_delivery: "Out for delivery", returned_to_sender: "Returned to sender" };

function tracking(t: Tracking, transmissionId: string, deliveryId: string, refresh: () => void): HTMLElement {
  const box = h("div", "border-border mt-3 flex flex-col gap-2 rounded-md border p-3 text-sm");
  box.append(h("p", "font-medium", mailClassLabels[t.mailingClass ?? ""] ? `Sent as ${mailClassLabels[t.mailingClass ?? ""]}` : "Mail tracking"));
  if (t.trackingNumber) {
    const line = h("p", "", "USPS tracking number: ");
    const link = h("a", "break-all underline underline-offset-4", t.trackingNumber);
    link.href = t.trackingUrl ?? "#"; link.target = "_blank"; link.rel = "noopener";
    line.append(link);
    box.append(line);
  } else box.append(h("p", "text-muted-foreground", "PostGrid adds the tracking number after the letter is processed for delivery."));
  if (t.imbStatus) box.append(h("p", "", `Latest USPS scan: ${scanLabels[t.imbStatus] ?? t.imbStatus}${t.imbZIPCode ? ` at ZIP ${t.imbZIPCode}` : ""}${t.imbDate ? `, ${when(t.imbDate)}` : ""}`));
  if (t.imbEvents.length) {
    const list = h("ol", "text-muted-foreground flex flex-col gap-1 pl-4 text-xs");
    for (const e of t.imbEvents) list.append(h("li", "", `${scanLabels[e.status] ?? e.status}${e.zipCode ? ` · ZIP ${e.zipCode}` : ""} · ${when(e.date)}`));
    box.append(list);
  }
  if (t.checkedAt) box.append(h("p", "text-muted-foreground text-xs", `Checked with PostGrid ${when(t.checkedAt)}`));
  if (t.returnReceipt) {
    const link = h("a", "underline underline-offset-4", "View return receipt");
    link.href = t.returnReceipt.url; link.target = "_blank"; link.rel = "noopener";
    box.append(link, h("p", "text-muted-foreground text-xs break-all", `Attached ${when(t.returnReceipt.uploadedAt)} · SHA-256 ${t.returnReceipt.sha256}`));
  }
  if (t.returnReceiptRequested || t.returnReceipt) {
    if (!t.returnReceipt) box.append(h("p", "text-muted-foreground", "USPS emails the signed return receipt to the sender. Attach that PDF here to keep it with this record."));
    const label = h("label", "flex flex-col gap-1", t.returnReceipt ? "Replace the return receipt PDF" : "Attach the return receipt PDF");
    const input = h("input", "text-sm"); input.type = "file"; input.accept = "application/pdf";
    const result = h("p", "text-sm"); result.setAttribute("role", "status");
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      input.disabled = true;
      try {
        await api(`/api/transmissions/${transmissionId}/mail/${deliveryId}/receipt`, { method: "PUT", body: file, headers: { "content-type": "application/pdf" } });
        refresh();
      } catch (error) { result.textContent = error instanceof Error ? error.message : "Could not attach the receipt."; input.disabled = false; }
    };
    label.append(input);
    box.append(label, result);
  }
  return box;
}

function note(delivery: Delivery): string {
  if (delivery.needsApproval) return delivery.channel === "fax" ? "This fax has not been approved or sent. Start again from Send to review a new proof." : "This letter was not confirmed, so nothing was mailed. Start again from Send.";
  if (delivery.status === "queued") return "Waiting its turn. It has not been sent yet.";
  if (delivery.status === "accepted" && delivery.channel === "fax") return "Telnyx has the fax. It is not delivered until the receiving machine confirms.";
  if (delivery.status === "accepted" && delivery.channel === "email") return "Email accepted for sending; delivery is not confirmed.";
  if (delivery.status === "accepted") return "PostGrid has the letter. It is not printed or mailed yet.";
  if (delivery.status === "completed") return delivery.tracking?.trackingNumber ? "PostGrid reports the letter as completed. Use the USPS tracking number for delivery." : "PostGrid reports the letter as completed. That is not a delivery confirmation.";
  return "";
}

function row(delivery: Delivery, transmissionId: string, refresh: () => void): HTMLElement {
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
  if (delivery.canRevoke) {
    const revoke = h("button", "mt-3 text-sm underline underline-offset-4", "Revoke email link");
    revoke.type = "button";
    const result = h("p", "mt-2 text-sm");
    result.setAttribute("role", "status");
    revoke.onclick = async () => {
      if (!window.confirm("Revoke this link? The recipient will no longer be able to download the document. Copies already downloaded cannot be recalled.")) return;
      revoke.disabled = true;
      try { await postJson(`/api/transmissions/${transmissionId}/email/${delivery.id}/revoke`, {}); refresh(); }
      catch { result.textContent = "Could not revoke this link. Refresh the record and try again."; revoke.disabled = false; }
    };
    card.append(revoke, result);
  }
  if (delivery.tracking) card.append(tracking(delivery.tracking, transmissionId, delivery.id, refresh));
  card.append(timeline(delivery));
  return card;
}

function info(detail: Detail, refresh: () => void): DocumentFragment {
  const frag = document.createDocumentFragment();
  const head = h("div", "flex flex-wrap items-baseline justify-between gap-2");
  head.append(h("h3", "text-lg font-semibold", detail.title), h("span", "text-muted-foreground text-sm", `${detail.pageCount} ${detail.pageCount === 1 ? "page" : "pages"}`));
  frag.append(head, h("p", "text-muted-foreground mt-1 text-sm", `Created ${when(detail.createdAt)} · last change ${when(detail.updatedAt)}`));
  if (detail.envelopeNumber) {
    frag.append(h("p", "mt-3 text-sm font-medium", `Envelope ${detail.envelopeNumber}`));
    const documents = h("ol", "mt-1 flex list-decimal flex-col gap-1 pl-5 text-sm");
    for (const doc of detail.documents ?? []) {
      documents.append(h("li", "break-all", `${doc.number} · ${doc.name} (${doc.pageCount} ${doc.pageCount === 1 ? "page" : "pages"})`));
    }
    frag.append(documents);
  }
  const list = h("div", "mt-4 flex flex-col gap-3");
  for (const delivery of detail.deliveries) list.append(row(delivery, detail.id, refresh));
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
      body.replaceChildren(info(detail, () => { clearTimeout(timer); void tick(); }));
      if (!loaded && withPreview) {
        const frame = h("iframe", "border-border h-[28rem] w-full rounded-lg border");
        frame.src = detail.documentUrl; frame.title = `Preview of ${detail.title}`;
        const link = h("a", "mt-2 inline-block text-sm underline underline-offset-4", "Open the PDF in a new tab");
        link.href = detail.documentUrl; link.target = "_blank"; link.rel = "noopener";
        preview.append(frame, link);
      }
      loaded = true;
      if (detail.settled || detail.deliveries.every((d) => d.channel === "email" || isTerminal(d.status) || d.needsApproval)) return;
    } catch {
      if (!loaded) body.replaceChildren(h("div", alert({ variant: "error", class: "p-3 text-sm" }), "Could not load this record. Try again in a moment."));
    }
    timer = setTimeout(tick, 4000);
  };
  void tick();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
