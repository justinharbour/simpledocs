import { describe, expect, it } from "vitest";
import { channels } from "@/lib/channels";
import { isCurrent, normalizePath, primaryNav, secondaryNav } from "@/lib/navigation";

describe("navigation", () => {
  it("normalizes paths to a trailing slash", () => {
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("/fax")).toBe("/fax/");
    expect(normalizePath("/fax/")).toBe("/fax/");
  });

  it("marks only the matching destination as current", () => {
    const current = [...primaryNav, ...secondaryNav].filter((item) => isCurrent(item.href, "/mail"));
    expect(current.map((item) => item.label)).toEqual(["Mail"]);
  });

  it("uses unique hrefs and labels", () => {
    const all = [...primaryNav, ...secondaryNav];
    expect(new Set(all.map((i) => i.href)).size).toBe(all.length);
    expect(new Set(all.map((i) => i.label)).size).toBe(all.length);
  });
});

describe("channels", () => {
  it("reports every channel as not connected", () => {
    expect(channels.length).toBeGreaterThan(0);
    for (const channel of channels) expect(channel.state).toBe("not-connected");
  });

  it("links only to known pages", () => {
    const known = new Set([...primaryNav, ...secondaryNav].map((i) => i.href));
    for (const channel of channels) expect(known.has(channel.href)).toBe(true);
  });
});
