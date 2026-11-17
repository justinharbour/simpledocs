import type { DeliveryState } from "@/lib/delivery";

// Synthetic examples that show how states read. They are not stored, sent or received by anything.
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
    note: "The provider reported delivery. This is the only state that claims it.",
  },
  {
    job: "Example job A",
    channel: "Paper mail",
    state: "failed",
    note: "Mail failed on its own. The fax is not sent again because of it.",
  },
  {
    job: "Example job B",
    channel: "Paper mail",
    state: "unknown",
    note: "The request timed out, so it is unclear whether the provider accepted it. Check with the provider; do not resend.",
  },
  {
    job: "Example job C",
    channel: "Paper mail",
    state: "awaiting_approval",
    note: "A provider proof is ready to review. Nothing is sent until you approve it.",
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
