// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SaveSelectionArgs, SaveSelectionRefusal, SaveSelectionResult } from "../shared/picker-contract";
import { EVIDENCE, linkedInput, pickerInput, PRESELECT } from "../../test/support/picker-fixture";
import { startUiHost, type UiHost } from "../../test/support/ui-host";
import { mountPicker, type PickerDeps } from "./view";

let root: HTMLElement;

beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement("div");
  root.id = "app";
  document.body.append(root);
});

const SAVED: SaveSelectionResult = { selection_id: "sel-7f3a", digest: "d1g3st", count: 12, total_bytes: 1 };

function deps(over: Partial<PickerDeps> = {}): PickerDeps & { sent: string[]; saved: SaveSelectionArgs[] } {
  const sent: string[] = [];
  const saved: SaveSelectionArgs[] = [];
  return {
    locale: "en-GB",
    save: async (args) => {
      saved.push(args);
      return SAVED;
    },
    send: async (text) => {
      sent.push(text);
    },
    sent,
    saved,
    ...over,
  };
}

const $ = <T extends Element = HTMLElement>(selector: string) => root.querySelector<T>(selector) as T;
const item = (path: string, kind: "f" | "d" = "f") => $(`[data-key="${kind}:${path}"]`);
const box = (path: string, kind: "f" | "d" = "f") => item(path, kind).querySelector<HTMLInputElement>(":scope > .picker-row input") as HTMLInputElement;
const counter = () => $(".picker-counter").textContent;
const notice = () => $(".picker-refusal").textContent;
const submit = () => $<HTMLButtonElement>(".picker-primary");
const buttonNamed = (text: string) => Array.from(root.querySelectorAll("button")).find((b) => b.textContent === text) as HTMLButtonElement;
const tick = (input: HTMLInputElement) => {
  input.checked = !input.checked;
  input.dispatchEvent(new Event("change", { bubbles: true }));
};
const key = (target: HTMLElement, k: string) => target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("project picker view", () => {
  it("renders the matter fields prefilled, the tree, the counter '12 / 50 selected · 34.2 MB'", () => {
    mountPicker(root, pickerInput(), deps());
    expect($<HTMLInputElement>("#pk-title").value).toBe("Παπαδόπουλος ν. Δημοκρατίας");
    expect($<HTMLInputElement>("#pk-title").required).toBe(true);
    expect($<HTMLSelectElement>("#pk-type").value).toBe("civil");
    expect($<HTMLInputElement>("#pk-ref").value).toBe("Αγωγή 123/2026");
    expect($<HTMLTextAreaElement>("#pk-desc").value).toBe("");
    expect(Array.from(root.querySelectorAll("#pk-type option")).map((o) => o.textContent)).toEqual([
      "Not specified",
      "Civil",
      "Criminal",
      "Interim application",
      "Appeal",
      "Other",
    ]);
    expect($('[role="tree"]')).not.toBeNull();
    expect(root.querySelectorAll('[role="treeitem"]')).toHaveLength(5 + 67);
    expect(item("Pleadings/Αγωγή.pdf").textContent).toContain("Αγωγή.pdf");
    expect(item("Pleadings/Αγωγή.pdf").textContent).toContain("PDF");
    expect(item("Pleadings/Αγωγή.pdf").textContent).toContain("2.9 MB");
    expect(item("Notes/memo.txt").textContent).toContain("1.2 KB");
    expect(box("Brief.pdf").checked).toBe(true);
    expect(item("Brief.pdf").getAttribute("aria-checked")).toBe("true");
    expect(counter()).toBe("12 / 50 selected · 34.2 MB");
    expect(submit().textContent).toBe("Create matter & upload");
    expect(submit().disabled).toBe(false);
    expect(buttonNamed("Suggested")).toBeDefined();
    expect(buttonNamed("Clear")).toBeDefined();
    expect(root.querySelector(".picker-truncated")).toBeNull();
  });

  it("renders Greek strings when the host locale is el-CY, English for en-GB", () => {
    const handle = mountPicker(root, pickerInput(), deps({ locale: "el-CY" }));
    expect($(".picker-title").textContent).toBe("Νέα υπόθεση");
    expect($('label[for="pk-title"]').textContent).toBe("Τίτλος (υποχρεωτικό)");
    expect($('label[for="pk-ref"]').textContent).toBe("Αριθμός υπόθεσης");
    expect(Array.from(root.querySelectorAll("#pk-type option")).map((o) => o.textContent)).toEqual([
      "Χωρίς προσδιορισμό",
      "Αστική",
      "Ποινική",
      "Ενδιάμεση αίτηση",
      "Έφεση",
      "Άλλο",
    ]);
    expect(counter()).toBe("Επιλεγμένα 12 / 50 έγγραφα · 34,2 MB");
    expect(submit().textContent).toBe("Δημιουργία υπόθεσης και ανέβασμα");
    expect(buttonNamed("Προτεινόμενα")).toBeDefined();
    expect(buttonNamed("Καθαρισμός")).toBeDefined();
    expect(item("Old/huge.pdf").textContent).toContain("Πολύ μεγάλο (άνω των 50 MB)");
    expect(item("Old/filed.pdf").textContent).toContain("Έχει ήδη ανέβει");
    expect($(".picker").getAttribute("lang")).toBe("el");

    // The host switches language: the selection and the fields stay, the strings change.
    tick(box("Notes/memo.txt"));
    handle.setLocale("en-GB");
    expect(counter()).toBe("13 / 50 selected · 34.2 MB");
    expect(submit().textContent).toBe("Create matter & upload");
    expect($(".picker").getAttribute("lang")).toBe("en");
  });

  it("greys an ineligible row with its reason and an already-uploaded row as uploaded", () => {
    mountPicker(root, pickerInput(), deps());
    const huge = item("Old/huge.pdf");
    expect(huge.classList.contains("picker-ineligible")).toBe(true);
    expect(huge.getAttribute("aria-disabled")).toBe("true");
    expect(huge.textContent).toContain("Too large (over 50 MB)");
    expect(box("Old/huge.pdf").disabled).toBe(true);
    expect(item("Old/table.xlsx").textContent).toContain("Unsupported file type");
    const filed = item("Old/filed.pdf");
    expect(filed.classList.contains("picker-uploaded")).toBe(true);
    expect(filed.textContent).toContain("Already uploaded");
    expect(box("Old/filed.pdf").disabled).toBe(true);
    // Its reason is the row's description for a screen reader.
    expect(document.getElementById(huge.getAttribute("aria-describedby") ?? "")?.textContent).toBe("Too large (over 50 MB)");

    // The toggle hides them, and the folder that holds nothing else.
    const hide = $<HTMLInputElement>("#pk-hide");
    expect($('label[for="pk-hide"]').textContent).toBe("Hide files that cannot be uploaded");
    tick(hide);
    expect(huge.hidden).toBe(true);
    expect(filed.hidden).toBe(true);
    expect(item("Old", "d").hidden).toBe(true);
    expect(item("Brief.pdf").hidden).toBe(false);
    tick(hide);
    expect(huge.hidden).toBe(false);
  });

  it("refuses a tick past the room with a notice naming the limit", () => {
    mountPicker(root, pickerInput({ preselect: EVIDENCE.slice(0, 50) }), deps());
    expect(counter()).toBe("50 / 50 selected · 142.5 MB");
    tick(box("Brief.pdf"));
    expect(box("Brief.pdf").checked).toBe(false);
    expect(counter()).toBe("50 / 50 selected · 142.5 MB");
    expect(notice()).toBe("Your plan allows 50 documents per matter.");
    expect($(".picker-refusal").getAttribute("role")).toBe("alert");
    // Making room clears the notice.
    tick(box(EVIDENCE[0]));
    expect(notice()).toBe("");
  });

  it("names the matter's documents in linked mode and the call cap when that binds", () => {
    mountPicker(root, linkedInput({ preselect: EVIDENCE.slice(0, 20) }), deps());
    tick(box("Brief.pdf"));
    expect(notice()).toBe("Matter #12 holds 30 of the 50 documents your plan allows per matter; 20 more fit.");
    root.replaceChildren();
    mountPicker(root, pickerInput({ per_matter: null, room: 100, preselect: [] }), deps());
    tick(box("", "d"));
    tick(box("", "d")); // all 64 ticked now: clears
    expect(counter()).toBe("0 / 100 selected · 0 B");
  });

  it("folder checkbox: tri-state; ticks up to the room", () => {
    mountPicker(root, pickerInput(), deps());
    const evidence = box("Evidence", "d");
    expect(evidence.indeterminate).toBe(true);
    expect(item("Evidence", "d").getAttribute("aria-checked")).toBe("mixed");
    expect(box("Pleadings", "d").checked).toBe(true);
    expect(item("Pleadings", "d").getAttribute("aria-checked")).toBe("true");
    expect(item("Notes", "d").getAttribute("aria-checked")).toBe("false");
    expect(box("Old", "d").disabled).toBe(true);

    tick(evidence);
    expect(counter()).toBe("50 / 50 selected · 142.5 MB");
    expect(box(EVIDENCE[46]).checked).toBe(true);
    expect(box(EVIDENCE[47]).checked).toBe(false);
    expect(evidence.indeterminate).toBe(true);
    expect(notice()).toBe("38 added, 13 left out. Your plan allows 50 documents per matter.");

    tick(box("Pleadings", "d"));
    expect(box("Pleadings", "d").checked).toBe(false);
    expect(item("Pleadings", "d").getAttribute("aria-checked")).toBe("false");
    expect(counter()).toBe("48 / 50 selected · 136.8 MB");
  });

  it("disables the main button for an empty title, an empty selection, an over-room selection", () => {
    mountPicker(root, pickerInput(), deps());
    const title = $<HTMLInputElement>("#pk-title");
    title.value = "   ";
    title.dispatchEvent(new Event("input"));
    expect(submit().disabled).toBe(true);
    expect($("#pk-hint").textContent).toBe("Enter a title for the matter.");
    title.value = "Αγωγή";
    title.dispatchEvent(new Event("input"));
    expect(submit().disabled).toBe(false);
    expect($("#pk-hint").textContent).toBe("");

    buttonNamed("Clear").click();
    expect(counter()).toBe("0 / 50 selected · 0 B");
    expect(submit().disabled).toBe(true);
    expect($("#pk-hint").textContent).toBe("Select at least one document.");
    buttonNamed("Suggested").click();
    expect(counter()).toBe("12 / 50 selected · 34.2 MB");
    expect(submit().disabled).toBe(false);

    root.replaceChildren();
    mountPicker(root, pickerInput({ room: 5 }), deps());
    expect(counter()).toBe("12 / 5 selected · 34.2 MB");
    expect(submit().disabled).toBe(true);
    expect($("#pk-hint").textContent).toBe("The selection is over the limit of 5 documents. Untick some.");
  });

  it("re-run mode: shows 'Adding to matter #12 “…”' read-only and the button 'Upload to matter #12'", () => {
    mountPicker(root, linkedInput(), deps());
    expect($(".picker-linked").textContent).toBe("Adding to matter #12 “Παπαδόπουλος ν. Δημοκρατίας”");
    expect(root.querySelector("input[type=text], textarea, select")).toBeNull();
    expect(submit().textContent).toBe("Upload to matter #12");
    expect(counter()).toBe("5 / 20 selected · 14.3 MB");
    root.replaceChildren();
    mountPicker(root, linkedInput(), deps({ locale: "el" }));
    expect($(".picker-linked").textContent).toBe("Προστίθενται στην υπόθεση #12 «Παπαδόπουλος ν. Δημοκρατίας»");
    expect(submit().textContent).toBe("Ανέβασμα στην υπόθεση #12");
  });

  it("submit: calls save_selection with the paths and fields, then sends one ui/message with selection_id and digest, then shows 'Sent to Claude'", async () => {
    const d = deps();
    mountPicker(root, pickerInput(), d);
    const title = $<HTMLInputElement>("#pk-title");
    title.value = "  Παπαδόπουλος ν. Δημοκρατίας  ";
    title.dispatchEvent(new Event("input"));
    const description = $<HTMLTextAreaElement>("#pk-desc");
    description.value = "Αγωγή για αποζημιώσεις";
    description.dispatchEvent(new Event("input"));
    submit().click();
    expect(submit().disabled).toBe(true); // in flight
    expect(submit().textContent).toBe("Saving the selection…");
    await vi.waitFor(() => expect($(".picker-sent")).not.toBeNull());
    expect(d.saved).toHaveLength(1);
    expect(d.saved[0].scan_id).toBe("scan-1");
    expect([...d.saved[0].relative_paths].sort()).toEqual([...PRESELECT].sort());
    expect(d.saved[0].matter).toEqual({
      title: "Παπαδόπουλος ν. Δημοκρατίας",
      type: "civil",
      case_reference: "Αγωγή 123/2026",
      description: "Αγωγή για αποζημιώσεις",
    });
    expect(d.sent).toEqual([
      'Confirmed in the picker: create matter “Παπαδόπουλος ν. Δημοκρατίας” with 12 files. Run init_matter with selection_id "sel-7f3a" and digest "d1g3st".',
    ]);
    expect($(".picker-sent").textContent).toBe("Sent to Claude — the upload runs in the chat.");
  });

  it("linked submit sends no matter and confirms in Greek", async () => {
    const d = deps({ locale: "el-CY", save: async () => ({ ...SAVED, count: 5 }) });
    mountPicker(root, linkedInput(), d);
    submit().click();
    await vi.waitFor(() => expect($(".picker-sent")).not.toBeNull());
    expect(d.sent).toEqual([
      'Επιβεβαιώθηκε στην επιλογή αρχείων: προσθήκη 5 αρχείων στην υπόθεση #12 «Παπαδόπουλος ν. Δημοκρατίας». Εκτελέστε το init_matter με selection_id "sel-7f3a" και digest "d1g3st".',
    ]);
    expect($(".picker-sent").textContent).toBe("Στάλθηκε στο Claude — το ανέβασμα συνεχίζεται στη συνομιλία.");
  });

  it("a save_selection refusal is shown and the picker stays editable", async () => {
    let answer: SaveSelectionResult | SaveSelectionRefusal = { refused: "ineligible", path: "Brief.pdf" };
    const d = deps({ save: async () => answer });
    mountPicker(root, pickerInput(), d);
    submit().click();
    await vi.waitFor(() => expect(notice()).toBe("Brief.pdf cannot be uploaded. Untick it and try again."));
    expect(d.sent).toEqual([]);
    expect(submit().disabled).toBe(false);
    expect(submit().textContent).toBe("Create matter & upload");
    tick(box("Brief.pdf"));
    expect(counter()).toBe("11 / 50 selected · 31.4 MB");

    answer = { refused: "unknown_scan" };
    submit().click();
    await vi.waitFor(() => expect(notice()).toContain("Ask Claude to scan the folder again."));

    const failing = deps({ save: async () => Promise.reject(new Error("bridge down")) });
    root.replaceChildren();
    mountPicker(root, pickerInput(), failing);
    submit().click();
    await vi.waitFor(() => expect(notice()).toBe("The selection could not be saved. Try again."));
    expect(submit().disabled).toBe(false);
  });

  it("keyboard: arrow keys move through the tree, space ticks; the counter is in an aria-live region", () => {
    mountPicker(root, pickerInput(), deps());
    expect($(".picker-counter").getAttribute("aria-live")).toBe("polite");
    const tree = $('[role="tree"]');
    const rootItem = item("", "d");
    expect(rootItem.tabIndex).toBe(0);
    expect(item("Brief.pdf").tabIndex).toBe(-1);
    rootItem.focus();

    key(rootItem, "ArrowDown");
    expect(document.activeElement).toBe(item("Brief.pdf"));
    expect(item("Brief.pdf").tabIndex).toBe(0);
    key(item("Brief.pdf"), " ");
    expect(box("Brief.pdf").checked).toBe(false);
    expect(counter()).toBe("11 / 50 selected · 31.4 MB");
    key(item("Brief.pdf"), " ");
    expect(counter()).toBe("12 / 50 selected · 34.2 MB");

    key(item("Brief.pdf"), "ArrowDown");
    const evidence = item("Evidence", "d");
    expect(document.activeElement).toBe(evidence);
    expect(evidence.getAttribute("aria-expanded")).toBe("true");
    key(evidence, "ArrowLeft");
    expect(evidence.getAttribute("aria-expanded")).toBe("false");
    key(evidence, "ArrowDown"); // past the closed folder, to Notes (closed: no preselected file in it)
    const notes = item("Notes", "d");
    expect(document.activeElement).toBe(notes);
    expect(notes.getAttribute("aria-expanded")).toBe("false");
    key(notes, "ArrowRight");
    expect(notes.getAttribute("aria-expanded")).toBe("true");
    key(notes, "ArrowRight");
    expect(document.activeElement).toBe(item("Notes/memo.txt"));
    key(item("Notes/memo.txt"), " ");
    expect(box("Notes/memo.txt").checked).toBe(true);
    key(item("Notes/memo.txt"), "ArrowLeft");
    expect(document.activeElement).toBe(notes);
    key(notes, "ArrowUp");
    expect(document.activeElement).toBe(evidence);
    key(evidence, "Home");
    expect(document.activeElement).toBe(rootItem);
    key(rootItem, " "); // the root's box: tick everything up to the room (memo.txt among the 50)
    expect(counter()).toBe("50 / 50 selected · 139.7 MB");
    expect(tree.getAttribute("aria-multiselectable")).toBe("true");
  });

  it("a truncated scan shows the truncation notice", () => {
    mountPicker(root, pickerInput({ truncated: "entries" }), deps());
    expect($(".picker-truncated").textContent).toContain("Only part of this folder was scanned");
    root.replaceChildren();
    mountPicker(root, pickerInput({ truncated: "depth" }), deps({ locale: "el-GR" }));
    expect($(".picker-truncated").textContent).toContain("Ο φάκελος σαρώθηκε εν μέρει");
  });

  it("builds the rows from names as text, never as markup", () => {
    const input = pickerInput({
      files: [{ path: "<img src=x onerror=alert(1)>.pdf", name: "<img src=x onerror=alert(1)>.pdf", size_bytes: 10, type: "pdf", eligible: true }],
      preselect: [],
    });
    mountPicker(root, input, deps());
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("<img src=x onerror=alert(1)>.pdf");
  });
});

describe("project picker wiring (App ↔ AppBridge over PostMessageTransport)", () => {
  let host: UiHost | null = null;
  // The SDK's transport logs every message with console.debug.
  beforeEach(() => void vi.spyOn(console, "debug").mockImplementation(() => undefined));
  afterEach(async () => {
    await host?.close();
    host = null;
    vi.restoreAllMocks();
  });

  it("loads the tree with load_picker, saves with save_selection and sends one ui/message", async () => {
    host = await startUiHost(root, {
      hostContext: { theme: "dark", locale: "el-CY", styles: { variables: { "--color-text-primary": "#eee" } as never } },
      onTool: ({ name, arguments: args }) => {
        if (name === "load_picker") return { content: [{ type: "text", text: "ok" }], structuredContent: { ...pickerInput(), scan_id: String(args?.scan_id) } };
        if (name === "save_selection") return { content: [{ type: "text", text: "saved" }], structuredContent: { ...SAVED } };
        return { isError: true, content: [{ type: "text", text: "unknown tool" }] };
      },
    });
    expect(root.textContent).toBe("Αναμονή για τη σάρωση του φακέλου…");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--color-text-primary")).toBe("#eee");

    // A result without a scan_id is not the picker's.
    await host.deliverToolResult({ content: [{ type: "text", text: "no" }], structuredContent: { other: 1 } });
    await host.deliverToolResult({
      content: [{ type: "text", text: "The picker is open." }],
      structuredContent: { status: "picker_open", scan_id: "scan-9", mode: "new", room: 50, eligible: 64, preselected: 12 },
    });
    await vi.waitFor(() => expect(root.querySelector(".picker-primary")).not.toBeNull());
    expect(host.calls).toEqual([{ name: "load_picker", arguments: { scan_id: "scan-9" } }]);
    expect(counter()).toBe("Επιλεγμένα 12 / 50 έγγραφα · 34,2 MB");

    submit().click();
    await vi.waitFor(() => expect(root.querySelector(".picker-sent")).not.toBeNull());
    expect(host.calls[1].name).toBe("save_selection");
    expect(host.calls[1].arguments).toMatchObject({ scan_id: "scan-9", matter: { title: "Παπαδόπουλος ν. Δημοκρατίας" } });
    expect(host.messages).toHaveLength(1);
    expect(host.messages[0].role).toBe("user");
    const text = (host.messages[0].content[0] as { type: string; text: string }).text;
    expect(text).toContain('selection_id "sel-7f3a"');
    expect(text).toContain('digest "d1g3st"');
    expect(text).toContain("init_matter");

    // The host switches to English: the sent state follows.
    await host.bridge.sendHostContextChange({ locale: "en-GB" });
    await vi.waitFor(() => expect(root.textContent).toBe("Sent to Claude — the upload runs in the chat."));
  });

  it("an expired scan: load_picker's error shows the notice", async () => {
    host = await startUiHost(root, {
      onTool: () => ({ isError: true, content: [{ type: "text", text: "unknown_scan" }] }),
    });
    await host.deliverToolResult({
      content: [{ type: "text", text: "The picker is open." }],
      structuredContent: { status: "picker_open", scan_id: "gone", mode: "new", room: 50, eligible: 1, preselected: 0 },
    });
    await vi.waitFor(() => expect(root.textContent).toBe("This list has expired; ask Claude to open the picker again."));
    await flush();
    expect(host.messages).toEqual([]);
  });

  it("a save_selection refusal over the bridge is shown and nothing is sent", async () => {
    host = await startUiHost(root, {
      onTool: ({ name }) =>
        name === "load_picker"
          ? { content: [{ type: "text", text: "ok" }], structuredContent: { ...pickerInput() } }
          : { isError: true, content: [{ type: "text", text: "over room" }], structuredContent: { refused: "over_room" } },
    });
    await host.deliverToolResult({ content: [], structuredContent: { status: "picker_open", scan_id: "scan-1", mode: "new", room: 50, eligible: 64, preselected: 12 } });
    await vi.waitFor(() => expect(root.querySelector(".picker-primary")).not.toBeNull());
    submit().click();
    await vi.waitFor(() => expect(notice()).toBe("The selection is over the limit of documents for this matter. Untick some."));
    expect(host.messages).toEqual([]);
    expect(submit().disabled).toBe(false);
  });
});
