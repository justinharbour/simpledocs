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
    expect(deliveryStateMeanings.unknown.toLowerCase()).toContain("not be treated as a failure");
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

  it("provides the draft editor and links to fax without placeholder controls", () => {
    const doc = read("/compose/");
    expect(doc).toContain('id="draft-form"');
    expect(doc).toMatch(/id="draft-fields"[^>]*disabled/);
    expect(doc).toContain('href="/fax/"');
    expect(doc).not.toContain("Synthetic example");
  });

  it("does not show invented records or channel switches", () => {
    expect(read("/records/")).toContain("Record listing is not available yet");
    expect(read("/records/")).not.toContain("Synthetic example");
    expect(read("/settings/")).not.toContain('role="switch"');
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
