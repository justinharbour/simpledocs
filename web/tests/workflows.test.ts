import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { primaryNav, secondaryNav } from "@/lib/navigation";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const built = existsSync(dist);
const read = (href: string) => readFileSync(`${dist}${href === "/" ? "" : href.slice(1)}index.html`, "utf8");

// Opening tags are matched quote-aware: Tailwind classes such as `has-[>svg]` contain a bare `>`.
const tagPattern = (names: string) => new RegExp(`<(?:${names})\\b(?:"[^"]*"|'[^']*'|[^>"'])*>`, "g");

describe.skipIf(!built)("workflow pages (run `pnpm build` first)", () => {
  const pages = [...primaryNav, ...secondaryNav].map((i) => i.href);

  it("does not ship the old separate compose, fax and mail pages", () => {
    for (const gone of ["compose", "fax", "mail"]) expect(existsSync(`${dist}${gone}/index.html`)).toBe(false);
  });

  it("walks through five steps, orders documents and reviews before sending", () => {
    const doc = read("/send/");
    for (const step of [1, 2, 3, 4, 5]) expect(doc).toContain(`data-step="${step}"`);
    expect(doc).toContain('id="document-order"');
    expect(doc).toContain('id="cover-numbers"');
    expect(doc).toContain("Review and confirm");
    expect(doc).toContain("Nothing is sent until you press Send");
    expect(doc).toContain('id="dropzone"');
    expect(doc).toContain('data-channel="fax"');
    expect(doc).toContain('data-channel="mail"');
    expect(doc).toContain('id="cover-preview"');
    expect(doc).not.toMatch(/acknowledg/i);
  });

  it("shows call history and voicemail next to the softphone", () => {
    const doc = read("/calls/");
    expect(doc).toContain('id="recordings"');
    expect(doc).toContain('id="call-log"');
    expect(doc).toContain('id="dial-form"');
  });

  it("lists records with a detail view", () => {
    const doc = read("/records/");
    expect(doc).toContain('id="list"');
    expect(doc).toContain('id="detail-view"');
  });

  it("edits the voicemail greeting and voice on the settings page, with no preview call", () => {
    const doc = read("/settings/");
    expect(doc).toContain('id="greeting"');
    expect(doc).toContain('id="greeting-count"');
    expect(doc).toContain('id="custom-voice"');
    expect(doc).toContain('id="price"');
    for (const voice of ["Telnyx.KokoroTTS.af", "AWS.Polly.Joanna-Neural", "AWS.Polly.Joanna"]) expect(doc).toContain(`value="${voice}"`);
    expect(doc).toContain('value="female"');
    expect(doc).toContain("next inbound call");
    expect(doc.toLowerCase()).not.toContain("preview");
  });

  it("has no placeholder, synthetic or unavailable-feature copy anywhere", () => {
    for (const href of pages) {
      const doc = read(href).toLowerCase();
      for (const phrase of ["synthetic example", "not connected", "coming soon", "not available yet", "preview only", "cannot currently be changed"]) {
        expect(doc, `${href} contains "${phrase}"`).not.toContain(phrase);
      }
    }
  });

  it.each(pages)("%s has no <label for> that points at a missing id", (href) => {
    const doc = read(href);
    const ids = new Set([...doc.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const targets = [...doc.matchAll(tagPattern("label"))]
      .map((m) => /\sfor="([^"]+)"/.exec(m[0])?.[1])
      .filter((v): v is string => Boolean(v));
    for (const target of targets) expect(ids.has(target), `label for="${target}"`).toBe(true);
  });

  it.each(pages)("%s has no aria-labelledby or aria-describedby pointing at a missing id", (href) => {
    const doc = read(href);
    const ids = new Set([...doc.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    for (const m of doc.matchAll(/aria-(?:labelledby|describedby)="([^"]+)"/g)) {
      for (const ref of m[1].split(/\s+/)) expect(ids.has(ref), `aria reference "${ref}"`).toBe(true);
    }
  });
});
