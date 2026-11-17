export type NavItem = {
  label: string;
  href: string;
  description: string;
};

export const primaryNav: readonly NavItem[] = [
  { label: "Overview", href: "/", description: "Channel status and recent activity." },
  { label: "Fax", href: "/fax/", description: "Faxes sent and received." },
  { label: "Calls", href: "/calls/", description: "Calls and voicemail." },
  { label: "Mail", href: "/mail/", description: "Physical mail, proofs and tracking." },
  { label: "Records", href: "/records/", description: "Documents and delivery records." },
];

export const secondaryNav: readonly NavItem[] = [
  { label: "Settings", href: "/settings/", description: "Which channels are turned on." },
];

export function normalizePath(pathname: string): string {
  if (pathname === "/") return "/";
  return pathname.endsWith("/") ? pathname : `${pathname}/`;
}

export function isCurrent(href: string, pathname: string): boolean {
  return normalizePath(pathname) === normalizePath(href);
}
