import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { primaryNav, secondaryNav } from "@/lib/navigation";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const built = existsSync(dist);

function html(href: string): string {
  const file = href === "/" ? "index.html" : `${href.slice(1)}index.html`;
  return readFileSync(`${dist}${file}`, "utf8");
}

describe.skipIf(!built)("built site (run `pnpm build` first)", () => {
  const pages = [...primaryNav, ...secondaryNav].map((i) => i.href);

  it.each(pages)("%s is static HTML with one h1, a language, a title and a main landmark", (href) => {
    const doc = html(href);
    expect(doc).toContain('<html lang="en"');
    expect(doc.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(doc).toMatch(/<title>[^<]+<\/title>/);
    expect(doc).toContain('id="main"');
    expect(doc).toContain('href="#main"');
  });

  // Starwind renders the sidebar twice (desktop rail and mobile sheet), so expect markers
  // only on links to this page, never on another destination.
  it.each(pages)("%s marks only its own link as the current page", (href) => {
    const doc = html(href);
    const total = doc.match(/aria-current="page"/g) ?? [];
    const own = [...doc.matchAll(/href="([^"]+)"[^<>]*? aria-current="page"/g)].map((m) => m[1]);
    expect(total.length).toBeGreaterThan(0);
    expect(own).toHaveLength(total.length);
    for (const target of own) expect(target).toBe(href);
  });

  it.each(pages.filter((href) => href !== "/compose/" && href !== "/fax/" && href !== "/mail/" && href !== "/calls/"))("%s states that nothing is connected and ships no form or fake action", (href) => {
    const doc = html(href);
    expect(doc).not.toMatch(/<form[\s>]/);
    expect(doc).not.toMatch(/type="submit"/);
    expect(doc.toLowerCase()).toMatch(/not connected|not available|not stored|nothing is connected|early build/);
  });

  it("provides a disconnected softphone with explicit call confirmation", () => {
    const doc = html('/calls/');
    expect(doc).toContain('Disconnected.');
    expect(doc).toContain('id="call-confirm"');
    expect(doc).toContain('id="call" disabled');
    expect(doc).toContain('Do not use this phone for emergency calls');
  });

  it("provides a fax form with explicit confirmation", () => {
    const doc = html("/fax/");
    expect(doc).toContain('id="fax-form"');
    expect(doc).toContain('name="document"');
    expect(doc).toContain('name="confirmed"');
  });

  it("provides a local mail review with an initially disabled confirmation", () => {
    const doc = html("/mail/");
    expect(doc).toContain('id="mail-form"');
    expect(doc).toMatch(/id="mail-form" method="post"/);
    expect(doc).toMatch(/id="mail-fields" disabled/);
    expect(doc).toContain('id="mail-payload"');
    expect(doc).toContain('id="mail-confirm"');
    expect(doc).toMatch(/id="mail-send"[^>]*disabled/);
    expect(doc).toContain('not rendered by PostGrid');
  });

  it("ships a 404 page that links home", () => {
    expect(readFileSync(`${dist}404.html`, "utf8")).toContain('href="/"');
  });

  it("does not request third-party hosts", () => {
    for (const href of pages) {
      const hosts = [...html(href).matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
      expect(hosts).toEqual([]);
    }
  });
});
