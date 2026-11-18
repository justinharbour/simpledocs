// @vitest-environment jsdom
import { expect, it } from "vitest";
import { renderDocumentOrder } from "@/lib/document-order";

it("moves a document with a native button, keeps focus, and announces its new position", () => {
  document.body.innerHTML = '<ol></ol><p role="status"></p>';
  const list = document.querySelector("ol")!;
  const status = document.querySelector("p")!;
  const docs = ["One.pdf", "Two.pdf", "Two.pdf"].map((name, i) => ({ file: new File([], name), pages: i + 1 }));
  renderDocumentOrder(list, status, docs);
  const up = list.querySelectorAll<HTMLButtonElement>('button[data-move="up"]');
  expect(up[0].disabled).toBe(true);
  expect(up[1].getAttribute("aria-label")).toBe("Move up: Two.pdf, document 2");
  up[1].focus(); up[1].click(); // Native button activation, also dispatched by Enter or Space.
  expect(docs.map(d => d.pages)).toEqual([2, 1, 3]);
  expect(status.textContent).toBe("Two.pdf moved to position 1 of 3.");
  expect(document.activeElement).toBe(list.children[0].querySelector('button[data-move="down"]'));
});

it("uses the same array for drag and drop and ignores external drops", () => {
  const list = document.createElement("ol"), status = document.createElement("p");
  const docs = ["A.pdf", "B.pdf", "C.pdf"].map(name => ({ file: new File([], name), pages: 1 }));
  renderDocumentOrder(list, status, docs);
  const dispatch = (i: number, type: string) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { setData() {} } });
    list.children[i].dispatchEvent(event);
    return event;
  };
  expect(dispatch(0, "drop").defaultPrevented).toBe(false);
  dispatch(2, "dragstart");
  expect(dispatch(0, "dragover").defaultPrevented).toBe(true);
  expect(dispatch(0, "drop").defaultPrevented).toBe(true);
  expect(docs.map(d => d.file.name)).toEqual(["C.pdf", "A.pdf", "B.pdf"]);
});
