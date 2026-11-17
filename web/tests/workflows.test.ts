import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deliveryStateLabels, deliveryStateMeanings, deliveryStates } from "@/lib/delivery";
import { exampleDeliveries } from "@/lib/examples";
import { flags, instanceChecks } from "@/lib/flags";
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

  it("exposes only the draft editor while sending and uploads remain unavailable", () => {
    const doc = read("/compose/");
    expect(doc).toContain('id="draft-form"');
    expect(doc).toMatch(/id="draft-fields"[^>]*disabled/);
    expect(doc).toContain('id="draft-status"');
    expect(doc).toContain('<noscript><p>JavaScript is required to load and save drafts.');
    expect(doc).toContain('id="send-reason"');
    expect(doc).toMatch(/id="document"[^>]*disabled/);
  });

  it.each(["/records/", "/settings/"])("%s ships no form, submit control or network action", (href) => {
    const doc = read(href);
    expect(doc).not.toMatch(/<form[\s>]/);
    expect(doc).not.toMatch(/type="submit"/);
    expect(doc).not.toMatch(/\saction="/);
    expect(doc).not.toMatch(/\sformaction="/);
    expect(doc).not.toMatch(/<script[^>]*\ssrc="https?:/);
  });

  // The shell's own controls (sidebar trigger, drawer close) are enabled; page controls are everything inside <main>.
  it.each(["/records/", "/settings/"])("%s has only disabled page controls", (href) => {
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

  it("Compose clearly states proof and sending are unavailable", () => {
    const text = read("/compose/").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("Provider proof is not available");
    expect(text).toContain("Sending is turned off");
    expect(text).toContain("synthetic example");
  });

  it("Compose does not promise proof and requires explicit confirmation for future paid sending", () => {
    const text = read("/compose/").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("will require your explicit confirmation");
    expect(text).not.toContain("The mail provider produces a proof");
    expect(text).not.toContain("is never sent again");
    expect(text).not.toContain("nothing is resent automatically");
  });

  it("Settings words the instance model and flags as proposed", () => {
    const text = read("/settings/").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("Proposed: simpledocs would be run by");
    expect(text).not.toContain("meant to be run by");
    expect(text).not.toContain("You will be asked to confirm");
    expect(text).not.toContain("will not cancel work");
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

  it("Compose names each checkbox with a real element and describes every group", () => {
    const doc = read("/compose/");
    const boxes = [...doc.matchAll(tagPattern("span"))].map((m) => m[0]).filter((t) => /role="checkbox"/.test(t));
    expect(boxes).toHaveLength(2);
    for (const tag of boxes) expect(tag).toMatch(/aria-labelledby="channel-(fax|mail)-label"/);
    const fieldsets = [...doc.matchAll(tagPattern("fieldset"))].map((m) => m[0]);
    expect(fieldsets.length).toBeGreaterThanOrEqual(3);
    for (const tag of fieldsets) expect(tag).toMatch(/aria-describedby="[^"]+"/);
  });

  it("Settings detail is shown below the md breakpoint, not only in a hidden column", () => {
    const doc = read("/settings/");
    const inline = [...doc.matchAll(tagPattern("span"))].map((m) => m[0]).filter((t) => /md:hidden/.test(t));
    expect(inline).toHaveLength(instanceChecks.length);
    for (const check of instanceChecks) expect(doc).toContain(check.detail);
  });

  it("Records shows each example note below the md breakpoint too", () => {
    const doc = read("/records/");
    expect(doc.match(/md:hidden/g)?.length).toBeGreaterThanOrEqual(exampleDeliveries.length);
  });

  it("marks every example surface with a strong Synthetic example label", () => {
    const records = read("/records/");
    expect(records.match(/Synthetic example/g)?.length).toBeGreaterThanOrEqual(exampleDeliveries.length + 1);
    const compose = read("/compose/");
    expect(compose.match(/Synthetic example/g)?.length).toBeGreaterThanOrEqual(3);
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
