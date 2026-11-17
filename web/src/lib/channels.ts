export type ChannelState = "not-connected";

export type Channel = {
  name: string;
  direction: string;
  state: ChannelState;
  needs: string;
  href: string;
};

export const stateLabels: Record<ChannelState, string> = {
  "not-connected": "Not connected",
};

export const channels: readonly Channel[] = [
  {
    name: "Fax",
    direction: "Send and receive",
    state: "not-connected",
    needs: "A fax provider account and number",
    href: "/fax/",
  },
  {
    name: "Voice",
    direction: "Make and receive",
    state: "not-connected",
    needs: "A phone provider account and number",
    href: "/calls/",
  },
  {
    name: "Voicemail",
    direction: "Receive",
    state: "not-connected",
    needs: "Voice connected and private recording storage",
    href: "/calls/",
  },
  {
    name: "Paper mail",
    direction: "Send",
    state: "not-connected",
    needs: "A mail provider account and an approved proof",
    href: "/mail/",
  },
];
