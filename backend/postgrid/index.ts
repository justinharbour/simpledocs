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

export interface ImmutableProofApproval {
  readonly deliveryId: string;
  readonly revision: number;
  readonly inputHash: string;
  readonly proofId: string;
  readonly proofHash: string;
  readonly actorId: string;
  readonly approvedAt: string;
}

export interface ProofReleaseContext {
  readonly liveEnabled: boolean;
  readonly proofReleaseVerified: boolean;
  readonly providerProofId: string;
  readonly currentDeliveryId: string;
  readonly currentRevision: number;
  readonly currentInputHash: string;
  readonly currentProofHash: string;
  readonly approval: ImmutableProofApproval | null;
}

/** Call immediately at dispatch after atomic revision/approval validation. */
export function assertLiveReleaseAllowed(context: ProofReleaseContext): void {
  if (!context.liveEnabled) throw new Error("Live mail is disabled");
  if (!context.proofReleaseVerified) throw new Error("Provider proof release is unverified; live mail is blocked");
  const approval = context.approval;
  if (!approval || !context.providerProofId) throw new Error("A provider-generated proof and explicit approval are required");
  if (
    approval.deliveryId !== context.currentDeliveryId ||
    approval.revision !== context.currentRevision ||
    approval.inputHash !== context.currentInputHash ||
    approval.proofId !== context.providerProofId ||
    approval.proofHash !== context.currentProofHash
  ) throw new Error("Approval does not match the immutable current delivery and proof");
}

/** A true implementation must be supplied from verified provider documentation. */
export interface WebhookVerifier {
  verify(rawBody: Uint8Array, headers: Readonly<Record<string, string>>): Promise<boolean>;
}

/** No verifier means no acceptance. Invoke only before durable inbox persistence. */
export async function authenticateWebhook(
  verifier: WebhookVerifier | null,
  rawBody: Uint8Array,
  headers: Readonly<Record<string, string>>,
): Promise<void> {
  if (!verifier) throw new Error("PostGrid webhook authentication is unverified; event rejected");
  if (!(await verifier.verify(rawBody, headers))) throw new Error("Invalid PostGrid webhook authentication");
}
