/** PostGrid domain boundary. This package deliberately performs no network I/O. */

export type MailingClass =
  | "first_class"
  | "standard_class"
  | "usps_first_class"
  | "usps_standard"
  | "usps_expedited"
  | "canada_post"
  | "australia_post"
  | "uk_first_class"
  | "uk_second_class";

export type NormalizedMailStatus =
  | "draft"
  | "submitted"
  | "processing"
  | "mailed"
  | "in_transit"
  | "delivered"
  | "failed"
  | "cancelled"
  | "unknown";

export interface MailTracking {
  trackingNumber?: string;
  carrier?: string;
  imb?: string;
  /** A tracking number is not proof of delivery or a signed return receipt. */
  deliveryEvidence: "none" | "provider_status";
}

export interface MailStatus {
  normalized: NormalizedMailStatus;
  raw: string;
  tracking: MailTracking;
}

const CLASS_BY_DESTINATION: Record<string, ReadonlySet<MailingClass>> = {
  US: new Set(["first_class", "standard_class", "usps_first_class", "usps_standard", "usps_expedited"]),
  CA: new Set(["canada_post"]),
  AU: new Set(["australia_post"]),
  GB: new Set(["uk_first_class", "uk_second_class"]),
};

/** Only accept known documented classes for an explicitly selected destination. */
export function validateMailingClass(destinationCountry: string, mailingClass: string): MailingClass {
  const country = destinationCountry.trim().toUpperCase();
  const allowed = CLASS_BY_DESTINATION[country];
  if (!allowed || !allowed.has(mailingClass as MailingClass)) {
    throw new Error("Unsupported or unverified mailing class for destination");
  }
  return mailingClass as MailingClass;
}

const STATUS: Readonly<Record<string, NormalizedMailStatus>> = {
  draft: "draft",
  queued: "submitted",
  submitted: "submitted",
  processing: "processing",
  processed: "processing",
  mailed: "mailed",
  in_transit: "in_transit",
  delivered: "delivered",
  failed: "failed",
  cancelled: "cancelled",
};

/** Preserve raw provider status; unknown/future values never become success. */
export function normalizeMailStatus(rawStatus: string, details: {
  trackingNumber?: string | null;
  carrier?: string | null;
  imb?: string | null;
} = {}): MailStatus {
  const raw = rawStatus.trim();
  const normalized = STATUS[raw.toLowerCase()] ?? "unknown";
  return {
    normalized,
    raw,
    tracking: {
      ...(details.trackingNumber ? { trackingNumber: details.trackingNumber } : {}),
      ...(details.carrier ? { carrier: details.carrier } : {}),
      ...(details.imb ? { imb: details.imb } : {}),
      deliveryEvidence: normalized === "delivered" ? "provider_status" : "none",
    },
  };
}

/**
 * Shape validation only. This is deliberately not an authorization decision:
 * caller-provided values are fabricable and readonly is compile-time only.
 * Live dispatch must remain unavailable until a trusted durable approval store,
 * authenticated actor, and atomic current-revision check are implemented.
 */
export interface ProofApprovalShape {
  deliveryId: string;
  revision: number;
  inputHash: string;
  proofId: string;
  proofHash: string;
  actorId: string;
  approvedAt: string;
}

const NONEMPTY = /^[^\s]+$/;
const SHA256_HEX = /^[a-f0-9]{64}$/i;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export function validateProofApprovalShape(value: unknown): value is ProofApprovalShape {
  if (!value || typeof value !== "object") return false;
  const approval = value as Record<string, unknown>;
  return typeof approval.deliveryId === "string" && NONEMPTY.test(approval.deliveryId) &&
    Number.isSafeInteger(approval.revision) && (approval.revision as number) >= 1 &&
    typeof approval.inputHash === "string" && SHA256_HEX.test(approval.inputHash) &&
    typeof approval.proofId === "string" && NONEMPTY.test(approval.proofId) &&
    typeof approval.proofHash === "string" && SHA256_HEX.test(approval.proofHash) &&
    typeof approval.actorId === "string" && NONEMPTY.test(approval.actorId) &&
    typeof approval.approvedAt === "string" && RFC3339_UTC.test(approval.approvedAt) &&
    Number.isFinite(Date.parse(approval.approvedAt));
}

/**
 * PostGrid webhook authentication is not implemented or verified. There is no
 * injectable callback: such a callback would only attest what its caller says.
 * Do not create/enable a production webhook endpoint until a provider-specific
 * verifier based on verified PostGrid documentation is implemented and tested.
 */
export function rejectUnauthenticatedWebhook(): never {
  throw new Error("PostGrid webhook authentication is not implemented; event rejected");
}
