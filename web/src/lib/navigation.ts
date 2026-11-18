export type NavItem = {
  label: string;
  href: string;
  description: string;
};

export const primaryNav: readonly NavItem[] = [
  { label: "Inbox", href: "/", description: "Faxes, voicemail, missed calls and texts that need you." },
  { label: "Send", href: "/send/", description: "Send one PDF by fax, paper mail, or both." },
  { label: "Calls", href: "/calls/", description: "Phone, call log and voicemail." },
  { label: "Messages", href: "/messages/", description: "Text messages." },
  { label: "Records", href: "/records/", description: "Everything sent and received." },
];

export const secondaryNav: readonly NavItem[] = [
  { label: "Settings", href: "/settings/", description: "Sender name and return address." },
];

export function normalizePath(pathname: string): string {
  if (pathname === "/") return "/";
  return pathname.endsWith("/") ? pathname : `${pathname}/`;
}

export function isCurrent(href: string, pathname: string): boolean {
  return normalizePath(pathname) === normalizePath(href);
}
