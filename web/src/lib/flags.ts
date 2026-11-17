// Capability flags proposed in docs/contracts.md. Every flag defaults to off and none can be changed from this build.
export type Flag = {
  id: string;
  label: string;
  detail: string;
};

export const flags: readonly Flag[] = [
  { id: "fax.outbound", label: "Send faxes", detail: "Outgoing faxes from this instance." },
  { id: "fax.inbound", label: "Receive faxes", detail: "Incoming faxes on a connected number." },
  { id: "voice.outbound", label: "Make calls", detail: "Outgoing calls from the browser." },
  { id: "voice.inbound", label: "Receive calls", detail: "Incoming calls on a connected number." },
  { id: "voice.voicemail", label: "Voicemail", detail: "Record and keep voicemail. Needs private storage." },
  { id: "mail.outbound", label: "Send paper mail", detail: "Letters sent only after you approve a provider proof." },
];

export type InstanceCheck = {
  name: string;
  detail: string;
};

// What an instance needs before any channel can be turned on. All are unconfigured in this build.
export const instanceChecks: readonly InstanceCheck[] = [
  { name: "Sign-in", detail: "Who may use this instance, and the identity provider that proves it." },
  { name: "Backend API", detail: "The service this page talks to. API version 1 is proposed, not published." },
  { name: "Private storage", detail: "Where documents, proofs and records are kept." },
  { name: "Provider accounts", detail: "Fax, phone and mail provider credentials, held by the operator." },
  { name: "Provider event intake", detail: "A separately authenticated address that receives delivery updates." },
];
