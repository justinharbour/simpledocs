import type { DeliveryState } from "@/lib/delivery";

// Synthetic examples that show how proposed states could read. They are not stored, sent or received by anything.
export type ExampleDelivery = {
  job: string;
  channel: "Fax" | "Paper mail";
  state: DeliveryState;
  note: string;
};

export const exampleDeliveries: readonly ExampleDelivery[] = [
  {
    job: "Example job A",
    channel: "Fax",
    state: "delivered",
    note: "The provider reported delivery. Only this state claims it.",
  },
  {
    job: "Example job A",
    channel: "Paper mail",
    state: "failed",
    note: "Proposed: a mail failure would not cause the delivered fax to be sent again.",
  },
  {
    job: "Example job B",
    channel: "Paper mail",
    state: "unknown",
    note: "Proposed: after a timeout the outcome is shown as unknown, not failed, and nothing would be resent automatically.",
  },
  {
    job: "Example job C",
    channel: "Paper mail",
    state: "awaiting_approval",
    note: "Proposed: a provider proof is ready to review, and nothing would be sent until it is approved.",
  },
];

export const exampleJob = {
  title: "Example job A",
  fax: { number: "(555) 010-0142", recipient: "Example Recipient" },
  mail: {
    recipient: "Example Recipient",
    address: ["100 Example Street", "Sampletown, ZZ 00000"],
  },
} as const;
