import { h } from "@/lib/ui";

export function renderDocumentOrder<T extends { file: File; pages: number }>(list: HTMLOListElement, status: HTMLElement, documents: T[]) {
  let dragged: T | undefined;

  function move(from: number, to: number, action?: "up" | "down") {
    if (from < 0 || to < 0 || to >= documents.length || from === to) return;
    const [doc] = documents.splice(from, 1);
    documents.splice(to, 0, doc);
    render();
    status.textContent = `${doc.file.name} moved to position ${to + 1} of ${documents.length}.`;
    if (action) {
      const row = list.children[to];
      const button = row.querySelector<HTMLButtonElement>(`[data-move="${action}"]:enabled`) ?? row.querySelector<HTMLButtonElement>("button:enabled");
      button?.focus();
    }
  }

  function render() {
    list.replaceChildren();
    documents.forEach((doc, index) => {
      const row = h("li", "border-border data-[over=true]:border-primary rounded-lg border p-3");
      row.draggable = documents.length > 1;
      row.addEventListener("dragstart", (event) => {
        if (!event.dataTransfer) return;
        dragged = doc;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", String(index + 1));
      });
      row.addEventListener("dragover", (event) => {
        if (!dragged || dragged === doc) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        row.dataset.over = "true";
      });
      row.addEventListener("dragleave", () => { delete row.dataset.over; });
      row.addEventListener("dragend", () => {
        dragged = undefined;
        for (const target of list.querySelectorAll<HTMLElement>("[data-over]")) delete target.dataset.over;
      });
      row.addEventListener("drop", (event) => {
        if (!dragged) return;
        event.preventDefault();
        const from = documents.indexOf(dragged);
        dragged = undefined;
        delete row.dataset.over;
        move(from, index);
      });
      const body = h("div", "flex flex-wrap items-center justify-between gap-2");
      body.append(h("span", "min-w-0 break-all text-sm", `${doc.file.name} · ${doc.pages} ${doc.pages === 1 ? "page" : "pages"}`));
      const actions = h("div", "flex flex-wrap gap-x-3");
      const button = (action: "up" | "down", delta: number) => {
        const text = `Move ${action}`;
        const control = h("button", "min-h-9 text-sm underline underline-offset-4 disabled:text-muted-foreground disabled:no-underline", text);
        control.type = "button";
        control.dataset.move = action;
        control.setAttribute("aria-label", `${text}: ${doc.file.name}, document ${index + 1}`);
        control.disabled = index + delta < 0 || index + delta >= documents.length;
        control.addEventListener("click", () => move(index, index + delta, action));
        return control;
      };
      if (documents.length > 1) { actions.append(button("up", -1), button("down", 1)); body.append(actions); }
      row.append(body); list.append(row);
    });
  }

  status.textContent = "";
  render();
}
