export type NavItem = {
  label: string;
  href: string;
  description: string;
};

export const primaryNav: readonly NavItem[] = [
  { label: "Overview", href: "/", description: "Where to start." },
  { label: "Send", href: "/send/", description: "Send one PDF by fax, paper mail, or both." },
  { label: "Calls", href: "/calls/", description: "Phone, call log and voicemail." },
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
