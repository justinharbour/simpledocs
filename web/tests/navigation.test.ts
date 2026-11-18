import { describe, expect, it } from "vitest";
import { isCurrent, normalizePath, primaryNav, secondaryNav } from "@/lib/navigation";

describe("navigation", () => {
  it("normalizes paths to a trailing slash", () => {
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("/send")).toBe("/send/");
    expect(normalizePath("/send/")).toBe("/send/");
  });

  it("marks only the matching destination as current", () => {
    const current = [...primaryNav, ...secondaryNav].filter((item) => isCurrent(item.href, "/records"));
    expect(current.map((item) => item.label)).toEqual(["Records"]);
  });

  it("uses unique hrefs and labels", () => {
    const all = [...primaryNav, ...secondaryNav];
    expect(new Set(all.map((i) => i.href)).size).toBe(all.length);
    expect(new Set(all.map((i) => i.label)).size).toBe(all.length);
  });

  it("offers the inbox first, then Send, Calls, Messages and Records", () => {
    expect(primaryNav.map((i) => i.label)).toEqual(["Inbox", "Send", "Calls", "Messages", "Records"]);
    expect(secondaryNav.map((i) => i.label)).toEqual(["Settings"]);
  });
});
