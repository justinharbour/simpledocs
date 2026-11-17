import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deliveryStateLabels, deliveryStateMeanings, deliveryStates } from "@/lib/delivery";
import { exampleDeliveries } from "@/lib/examples";
import { flags } from "@/lib/flags";
import { primaryNav } from "@/lib/navigation";

describe("delivery states", () => {
  it("labels and explains every proposed state", () => {
    expect(deliveryStates).toHaveLength(12);
    for (const state of deliveryStates) {
      expect(deliveryStateLabels[state].length).toBeGreaterThan(0);
      expect(deliveryStateMeanings[state].length).toBeGreaterThan(0);
    }
  });

  it("claims delivery only for the delivered state", () => {
    for (const state of deliveryStates) {
      if (state === "delivered") continue;
      expect(deliveryStateLabels[state].toLowerCase()).not.toContain("delivered");
    }
    expect(deliveryStateMeanings.submitted.toLowerCase()).toContain("not delivery");
    expect(deliveryStateMeanings.unknown.toLowerCase()).toContain("not treated as a failure");
  });

  it("shows partial success and an unknown outcome among the examples", () => {
    const states = exampleDeliveries.map((d) => d.state);
    expect(states).toContain("delivered");
    expect(states).toContain("failed");
    expect(states).toContain("unknown");
    for (const row of exampleDeliveries) expect(row.job).toMatch(/^Example /);
  });
});

describe("flags", () => {
  it("lists the six proposed identifiers and nothing else", () => {
    expect(flags.map((f) => f.id)).toEqual([
      "fax.outbound",
      "fax.inbound",
      "voice.outbound",
      "voice.inbound",
      "voice.voicemail",
      "mail.outbound",
    ]);
  });
});

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const built = existsSync(dist);
const read = (href: string) => readFileSync(`${dist}${href.slice(1)}index.html`, "utf8");

// Opening tags are matched quote-aware: Tailwind classes such as `has-[>svg]` contain a bare `>`.
const tagPattern = (names: string) => new RegExp(`<(?:${names})\\b(?:"[^"]*"|'[^']*'|[^>"'])*>`, "g");

// Every opening tag for a control a person could operate. Starwind's internal `hidden` state inputs are not controls.
function controls(doc: string): string[] {
  return [...doc.matchAll(tagPattern("button|input|textarea|select|span|div"))]
    .map((m) => m[0])
    .filter((tag) => /^<(button|input|textarea|select)\b/.test(tag) || /role="(checkbox|switch|radio|button)"/.test(tag))
    .filter((tag) => !/^<input\b[^>]*\shidden[\s>]/.test(tag));
}

describe.skipIf(!built)("workflow pages (run `pnpm build` first)", () => {
  const pages = ["/compose/", "/records/", "/settings/"];

  it("adds Compose to the primary navigation without removing a destination", () => {
    expect(primaryNav.map((i) => i.label)).toEqual(["Overview", "Compose", "Fax", "Calls", "Mail", "Records"]);
  });

  it.each(pages)("%s ships no form, submit control or network action", (href) => {
    const doc = read(href);
    expect(doc).not.toMatch(/<form[\s>]/);
    expect(doc).not.toMatch(/type="submit"/);
    expect(doc).not.toMatch(/\saction="/);
    expect(doc).not.toMatch(/\sformaction="/);
    expect(doc).not.toMatch(/<script[^>]*\ssrc="https?:/);
  });

  // The shell's own controls (sidebar trigger, drawer close) are enabled; page controls are everything inside <main>.
  it.each(pages)("%s has only disabled page controls", (href) => {
    const doc = read(href);
    const main = doc.slice(doc.indexOf('id="main"'));
    const page = controls(main).filter((tag) => !/data-sidebar=|data-slot="sidebar|data-slot="sheet/.test(tag));
    expect(page.length).toBeGreaterThan(0);
    for (const tag of page) {
      expect(tag, tag).toMatch(/\sdisabled(=|\s|>)|aria-disabled="true"/);
      // A span or div with an ARIA role has no native disabled state, so it must say so itself.
      if (/^<(span|div)\b/.test(tag)) expect(tag, tag).toContain('aria-disabled="true"');
    }
  });

  it.each(pages)("%s explains why it is unavailable", (href) => {
    expect(read(href)).toContain("Not available.");
  });

  it("describes every disabled button with a reason that exists on the page", () => {
    for (const href of ["/compose/", "/settings/"]) {
      const doc = read(href);
      const main = doc.slice(doc.indexOf('id="main"'));
      const buttons = [...main.matchAll(tagPattern("button"))].map((m) => m[0]);
      for (const tag of buttons.filter((t) => /data-slot="button"/.test(t))) {
        const ref = /aria-describedby="([^"]+)"/.exec(tag)?.[1];
        expect(ref, tag).toBeTruthy();
        expect(doc).toContain(`id="${ref}"`);
      }
    }
  });

  it("labels every page input", () => {
    for (const href of pages) {
      const doc = read(href);
      const main = doc.slice(doc.indexOf('id="main"'));
      for (const tag of controls(main).filter((t) => /^<(input|textarea)/.test(t))) {
        const id = /\sid="([^"]+)"/.exec(tag)?.[1];
        expect(id, tag).toBeTruthy();
        expect(doc, `label for ${id}`).toContain(`for="${id}"`);
      }
    }
  });

  it("Compose says proof comes from the provider and that sending is off", () => {
    const text = read("/compose/").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("The mail provider produces a proof");
    expect(text).toContain("Sending is turned off");
    expect(text).toContain("made-up examples");
  });

  it("Settings shows every flag off and none on", () => {
    const doc = read("/settings/");
    for (const flag of flags) expect(doc).toContain(`flag-${flag.id}`);
    const switches = [...doc.matchAll(tagPattern("button"))].map((m) => m[0]).filter((t) => /role="switch"/.test(t));
    expect(switches).toHaveLength(flags.length);
    for (const tag of switches) {
      expect(tag).toContain('aria-checked="false"');
      expect(tag).toMatch(/\sdisabled(\s|>|=)/);
    }
    expect(doc).not.toContain('aria-checked="true"');
  });

  it("Records labels its rows as examples, not records", () => {
    const doc = read("/records/");
    expect(doc).toContain("not records");
    expect(doc.match(/Example job/g)?.length).toBeGreaterThanOrEqual(exampleDeliveries.length);
  });
});
