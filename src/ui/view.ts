// The project picker's DOM over its model: the matter fields (or, for a linked folder, a read-only
// line), the tree with tri-state folder boxes, and the footer with the counter and the buttons. It is
// built with createElement and textContent only, never innerHTML, since every name in it comes from
// the lawyer's disk. It knows nothing of the MCP bridge: mountPicker takes the two calls it needs
// (save the selection, send the chat message), which main.ts wires to the App and the tests to stubs.

import {
  PICKER_MATTER_TYPES,
  type PickerFile,
  type PickerInput,
  type PickerMatterType,
  type SaveSelectionArgs,
  type SaveSelectionRefusal,
  type SaveSelectionResult,
} from "../shared/picker-contract";
import { type CheckState, PickerModel, TITLE_MAX, type TreeFolder } from "./model";
import { formatBytes, pickLang, type RoomLimit, STRINGS, type Strings } from "./strings";

/** The longest case reference and description create_matter accepts. */
const CASE_REFERENCE_MAX = 300;
const DESCRIPTION_MAX = 2000;

export interface PickerDeps {
  /** The host's locale ("el-CY", "en-GB", …); undefined when the host gave none. */
  locale: string | undefined;
  /** save_selection: its structuredContent, a result or a refusal. Throws when the call itself failed. */
  save(args: SaveSelectionArgs): Promise<SaveSelectionResult | SaveSelectionRefusal>;
  /** Posts the confirmation to the chat as the lawyer's message. */
  send(text: string): Promise<void>;
}

export interface PickerHandle {
  readonly model: PickerModel;
  /** Re-renders in the language of `locale`, keeping the selection, the fields and the open folders. */
  setLocale(locale: string | undefined): void;
}

/** A placeholder while no tool result has come yet (or a message when none can). */
export function showMessage(root: HTMLElement, text: string): void {
  root.replaceChildren(el("p", { class: "picker-message", role: "status" }, text));
  root.setAttribute("aria-busy", "false");
}

/** Renders the picker for `input` into `root` and wires its events. */
export function mountPicker(root: HTMLElement, input: PickerInput, deps: PickerDeps): PickerHandle {
  const model = new PickerModel(input);
  return new PickerView(root, model, deps);
}

type TreeNode = { kind: "folder"; folder: TreeFolder } | { kind: "file"; file: PickerFile };

class PickerView implements PickerHandle {
  readonly model: PickerModel;
  readonly #root: HTMLElement;
  readonly #deps: PickerDeps;
  #s: Strings;
  /** Open folders, by path. */
  readonly #expanded = new Set<string>();
  #hideIneligible = false;
  #busy = false;
  #sent = false;
  /** The tree item that takes Tab focus (roving tabindex), by its key ("d:path" or "f:path"). */
  #focusKey = "d:";
  // Elements of the current render.
  #items = new Map<string, { li: HTMLLIElement; box: HTMLInputElement; node: TreeNode }>();
  #tree!: HTMLUListElement;
  #counter!: HTMLElement;
  #notice!: HTMLElement;
  #hint!: HTMLElement;
  #submit!: HTMLButtonElement;

  constructor(root: HTMLElement, model: PickerModel, deps: PickerDeps) {
    this.#root = root;
    this.model = model;
    this.#deps = deps;
    this.#s = STRINGS[pickLang(deps.locale)];
    this.#expanded.add("");
    for (const path of model.selection().relative_paths) {
      for (let at = path.indexOf("/"); at !== -1; at = path.indexOf("/", at + 1)) this.#expanded.add(path.slice(0, at));
    }
    this.#render();
  }

  setLocale(locale: string | undefined): void {
    const next = STRINGS[pickLang(locale)];
    if (next === this.#s) return;
    this.#s = next;
    if (this.#sent) this.#renderSent();
    else this.#render();
  }

  // ── rendering ────────────────────────────────────────────────────────────────────────────────

  #render(): void {
    const s = this.#s;
    this.#items = new Map();
    const picker = el("div", { class: "picker", lang: s === STRINGS.el ? "el" : "en" });
    picker.append(this.#header());
    if (this.model.input.truncated !== null) {
      picker.append(el("p", { class: "picker-notice picker-truncated", role: "note" }, s.truncated[this.model.input.truncated]));
    }
    const toggle = el("input", { type: "checkbox", id: "pk-hide", class: "picker-hide" }) as HTMLInputElement;
    toggle.checked = this.#hideIneligible;
    toggle.addEventListener("change", () => {
      this.#hideIneligible = toggle.checked;
      this.#sync();
    });
    picker.append(el("div", { class: "picker-toolbar" }, toggle, el("label", { for: "pk-hide" }, s.hideIneligible)));

    this.#tree = el("ul", { class: "picker-tree", role: "tree", "aria-label": s.treeLabel, "aria-multiselectable": "true" }) as HTMLUListElement;
    this.#tree.append(this.#folderItem(this.model.root));
    this.#tree.addEventListener("keydown", (event) => this.#onKey(event));
    picker.append(this.#tree);
    picker.append(this.#footer());
    this.#root.replaceChildren(picker);
    this.#root.setAttribute("aria-busy", "false");
    this.#sync();
  }

  #header(): HTMLElement {
    const s = this.#s;
    const input = this.model.input;
    const header = el("header", { class: "picker-header" });
    if (this.model.mode === "linked" && input.linked_matter !== undefined) {
      header.append(el("p", { class: "picker-linked" }, s.linkedHeader(input.linked_matter.id, input.linked_matter.title)));
      header.append(el("p", { class: "picker-root" }, s.folder(input.root)));
      return header;
    }
    header.append(el("h1", { class: "picker-title" }, s.newMatter));
    header.append(el("p", { class: "picker-root" }, s.folder(input.root)));
    const draft = this.model.matter();
    const fields = el("div", { class: "picker-fields" });

    const title = el("input", { id: "pk-title", type: "text", required: "", maxlength: String(TITLE_MAX), autocomplete: "off" }) as HTMLInputElement;
    title.value = draft.title;
    title.addEventListener("input", () => {
      this.model.setMatter({ title: title.value });
      this.#syncFooter();
    });
    fields.append(field("pk-title", [s.title, el("span", { class: "picker-required" }, ` (${s.required})`)], title));

    const type = el("select", { id: "pk-type" }) as HTMLSelectElement;
    type.append(option("", s.typeNone));
    for (const value of PICKER_MATTER_TYPES) type.append(option(value, s.types[value]));
    type.value = draft.type;
    type.addEventListener("change", () => this.model.setMatter({ type: type.value as PickerMatterType | "" }));
    fields.append(field("pk-type", [s.type], type));

    const reference = el("input", { id: "pk-ref", type: "text", maxlength: String(CASE_REFERENCE_MAX), autocomplete: "off" }) as HTMLInputElement;
    reference.value = draft.case_reference;
    reference.addEventListener("input", () => this.model.setMatter({ case_reference: reference.value }));
    fields.append(field("pk-ref", [s.caseReference], reference));

    const description = el("textarea", { id: "pk-desc", rows: "2", maxlength: String(DESCRIPTION_MAX) }) as HTMLTextAreaElement;
    description.value = draft.description;
    description.addEventListener("input", () => this.model.setMatter({ description: description.value }));
    fields.append(field("pk-desc", [s.description], description, "picker-field-wide"));

    header.append(fields);
    return header;
  }

  #folderItem(folder: TreeFolder): HTMLLIElement {
    const key = `d:${folder.path}`;
    const name = folder.path === "" ? rootName(this.model.input.root) || this.#s.rootLabel : folder.name;
    const box = checkbox(() => this.#toggle(key));
    const twisty = el("span", { class: "picker-twisty", "aria-hidden": "true" });
    twisty.addEventListener("click", () => this.#setExpanded(folder.path, !this.#expanded.has(folder.path)));
    const label = el("span", { class: "picker-name" }, name);
    label.addEventListener("click", () => this.#setExpanded(folder.path, !this.#expanded.has(folder.path)));
    const row = el("div", { class: "picker-row picker-folder-row" }, twisty, box, label);
    const group = el("ul", { role: "group", class: "picker-group" });
    for (const file of folder.files) group.append(this.#fileItem(file, folder.depth + 1));
    for (const sub of folder.folders) group.append(this.#folderItem(sub));
    const li = el("li", { role: "treeitem", class: "picker-item picker-folder", "aria-level": String(folder.depth + 1), "aria-label": name, tabindex: "-1" }, row, group) as HTMLLIElement;
    li.dataset.key = key;
    li.addEventListener("focus", () => this.#setFocusKey(key));
    this.#items.set(key, { li, box, node: { kind: "folder", folder } });
    return li;
  }

  #fileItem(file: PickerFile, level: number): HTMLLIElement {
    const s = this.#s;
    const key = `f:${file.path}`;
    const box = checkbox(() => this.#toggle(key));
    const row = el("div", { class: "picker-row picker-file-row" }, el("span", { class: "picker-twisty picker-leaf", "aria-hidden": "true" }), box);
    const name = el("span", { class: "picker-name" }, file.name);
    name.addEventListener("click", () => {
      if (this.model.tickable(file.path)) this.#toggle(key);
    });
    row.append(name);
    if (file.type !== null) row.append(el("span", { class: `picker-badge picker-badge-${file.type}` }, s.fileTypes[file.type]));
    row.append(el("span", { class: "picker-size" }, formatBytes(file.size_bytes, s.locale)));
    const classes = ["picker-item", "picker-file"];
    const described: string[] = [];
    if (file.reason !== undefined) {
      const reasonId = `pk-reason-${this.#items.size}`;
      described.push(reasonId);
      row.append(el("span", { class: "picker-reason", id: reasonId }, s.reasons[file.reason]));
      classes.push(file.reason === "already_uploaded" ? "picker-uploaded" : "picker-ineligible");
    }
    const li = el("li", { role: "treeitem", class: classes.join(" "), "aria-level": String(level), "aria-label": file.name, tabindex: "-1" }, row) as HTMLLIElement;
    if (described.length > 0) li.setAttribute("aria-describedby", described.join(" "));
    li.dataset.key = key;
    li.addEventListener("focus", () => this.#setFocusKey(key));
    this.#items.set(key, { li, box, node: { kind: "file", file } });
    return li;
  }

  #footer(): HTMLElement {
    const s = this.#s;
    this.#notice = el("p", { class: "picker-notice picker-refusal", role: "alert" });
    this.#counter = el("p", { class: "picker-counter", "aria-live": "polite", "aria-atomic": "true" });
    this.#hint = el("p", { class: "picker-hint", id: "pk-hint" });
    const suggested = el("button", { type: "button", class: "picker-button" }, s.suggested) as HTMLButtonElement;
    suggested.addEventListener("click", () => {
      this.model.resetToSuggested();
      this.#say("");
      this.#sync();
    });
    const clear = el("button", { type: "button", class: "picker-button" }, s.clear) as HTMLButtonElement;
    clear.addEventListener("click", () => {
      this.model.clear();
      this.#say("");
      this.#sync();
    });
    const input = this.model.input;
    const label = this.model.mode === "linked" && input.linked_matter !== undefined ? s.uploadTo(input.linked_matter.id) : s.createAndUpload;
    this.#submit = el("button", { type: "button", class: "picker-button picker-primary", "aria-describedby": "pk-hint" }, label) as HTMLButtonElement;
    this.#submit.dataset.label = label;
    this.#submit.addEventListener("click", () => void this.#onSubmit());
    return el(
      "footer",
      { class: "picker-footer" },
      this.#notice,
      el("div", { class: "picker-footer-row" }, this.#counter, el("div", { class: "picker-buttons" }, suggested, clear, this.#submit)),
      this.#hint,
    );
  }

  #renderSent(): void {
    this.#root.replaceChildren(el("div", { class: "picker", lang: this.#s === STRINGS.el ? "el" : "en" }, el("p", { class: "picker-sent", role: "status" }, this.#s.sent)));
  }

  // ── state → DOM ──────────────────────────────────────────────────────────────────────────────

  /** Brings every box, row and the footer in line with the model. */
  #sync(): void {
    for (const { li, box, node } of this.#items.values()) {
      const state = node.kind === "folder" ? this.model.folderState(node.folder.path) : this.model.fileState(node.file.path);
      applyState(li, box, state);
      if (node.kind === "folder") {
        const open = this.#expanded.has(node.folder.path);
        li.setAttribute("aria-expanded", String(open));
        li.classList.toggle("picker-open", open);
        (li.lastElementChild as HTMLElement).hidden = !open;
        li.hidden = node.folder.path !== "" && this.#hideIneligible && this.model.tickableIn(node.folder.path).length === 0;
      } else {
        li.hidden = this.#hideIneligible && !this.model.tickable(node.file.path);
      }
    }
    if (!this.#visible().some((li) => li.dataset.key === this.#focusKey)) this.#focusKey = "d:";
    for (const [key, { li }] of this.#items) li.tabIndex = key === this.#focusKey ? 0 : -1;
    this.#syncFooter();
  }

  #syncFooter(): void {
    const s = this.#s;
    this.#counter.textContent = s.counter(this.model.selectedCount(), this.model.room, this.model.selectedBytes());
    const gate = this.model.canSubmit();
    this.#submit.disabled = this.#busy || !gate.ok;
    this.#submit.textContent = this.#busy ? s.saving : (this.#submit.dataset.label ?? "");
    this.#hint.textContent = gate.ok ? "" : s.gate[gate.why](this.model.room);
  }

  #say(text: string): void {
    this.#notice.textContent = text;
  }

  // ── events ───────────────────────────────────────────────────────────────────────────────────

  #toggle(key: string): void {
    const item = this.#items.get(key);
    if (item === undefined) return;
    const s = this.#s;
    if (item.node.kind === "file") {
      const result = this.model.toggleFile(item.node.file.path);
      this.#say("refused" in result && result.refused === "over_room" ? s.overRoom(this.#limit()) : "");
    } else {
      const result = this.model.toggleFolder(item.node.folder.path);
      this.#say(result.leftOut > 0 ? s.folderLeftOut(result.added, result.leftOut, this.#limit()) : "");
    }
    this.#sync();
  }

  #limit(): RoomLimit {
    const input = this.model.input;
    const plan = input.per_matter !== null && Math.max(input.per_matter - input.held, 0) <= this.model.room;
    return {
      room: this.model.room,
      perMatter: plan ? input.per_matter : null,
      held: input.held,
      matterId: input.mode === "linked" ? (input.linked_matter?.id ?? null) : null,
    };
  }

  #setExpanded(path: string, open: boolean): void {
    if (open) this.#expanded.add(path);
    else this.#expanded.delete(path);
    this.#sync();
  }

  #setFocusKey(key: string): void {
    if (this.#focusKey === key) return;
    this.#focusKey = key;
    for (const [k, { li }] of this.#items) li.tabIndex = k === key ? 0 : -1;
  }

  /** The tree items a user can reach: not hidden, and inside open folders only. */
  #visible(): HTMLLIElement[] {
    const out: HTMLLIElement[] = [];
    const walk = (folder: TreeFolder) => {
      const item = this.#items.get(`d:${folder.path}`);
      if (item === undefined || item.li.hidden) return;
      out.push(item.li);
      if (!this.#expanded.has(folder.path)) return;
      for (const file of folder.files) {
        const fileItem = this.#items.get(`f:${file.path}`);
        if (fileItem !== undefined && !fileItem.li.hidden) out.push(fileItem.li);
      }
      for (const sub of folder.folders) walk(sub);
    };
    walk(this.model.root);
    return out;
  }

  #focus(li: HTMLLIElement): void {
    const key = li.dataset.key ?? "d:";
    this.#setFocusKey(key);
    li.focus();
  }

  #onKey(event: KeyboardEvent): void {
    // Keys on a tree item only: a checkbox that took focus keeps its own Space.
    if (!(event.target instanceof HTMLElement) || event.target.getAttribute("role") !== "treeitem") return;
    const visible = this.#visible();
    const at = visible.findIndex((li) => li.dataset.key === this.#focusKey);
    const current = this.#items.get(this.#focusKey);
    if (at === -1 || current === undefined) return;
    const folder = current.node.kind === "folder" ? current.node.folder : null;
    switch (event.key) {
      case "ArrowDown":
        if (at + 1 < visible.length) this.#focus(visible[at + 1]);
        break;
      case "ArrowUp":
        if (at > 0) this.#focus(visible[at - 1]);
        break;
      case "Home":
        this.#focus(visible[0]);
        break;
      case "End":
        this.#focus(visible[visible.length - 1]);
        break;
      case "ArrowRight":
        if (folder === null) break;
        if (!this.#expanded.has(folder.path)) this.#setExpanded(folder.path, true);
        else if (at + 1 < visible.length && this.#parentKey(visible[at + 1].dataset.key ?? "") === this.#focusKey) {
          this.#focus(visible[at + 1]);
        }
        break;
      case "ArrowLeft": {
        if (folder !== null && this.#expanded.has(folder.path)) {
          this.#setExpanded(folder.path, false);
          break;
        }
        const parent = this.#items.get(this.#parentKey(this.#focusKey));
        if (parent !== undefined) this.#focus(parent.li);
        break;
      }
      case " ":
      case "Spacebar":
        this.#toggle(this.#focusKey);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  /** The key of the folder holding the item `key`; "" for the root itself. */
  #parentKey(key: string): string {
    const path = key.slice(2);
    if (key === "d:") return "";
    const at = path.lastIndexOf("/");
    return `d:${at === -1 ? "" : path.slice(0, at)}`;
  }

  async #onSubmit(): Promise<void> {
    if (this.#busy || !this.model.canSubmit().ok) return;
    const s = this.#s;
    const input = this.model.input;
    const { relative_paths, matter } = this.model.selection();
    const args: SaveSelectionArgs = { scan_id: input.scan_id, relative_paths };
    if (matter !== null) args.matter = matter;
    this.#busy = true;
    this.#say("");
    this.#syncFooter();
    try {
      let answer: SaveSelectionResult | SaveSelectionRefusal;
      try {
        answer = await this.#deps.save(args);
      } catch {
        this.#say(s.saveFailed);
        return;
      }
      if ("refused" in answer) {
        const text = s.refusals[answer.refused]?.(answer.path) ?? s.saveFailed;
        this.#say(text);
        return;
      }
      const text = s.confirmMessage(
        matter !== null
          ? { mode: "new", title: matter.title, count: answer.count, selectionId: answer.selection_id, digest: answer.digest }
          : {
              mode: "linked",
              matterId: input.linked_matter?.id ?? 0,
              title: input.linked_matter?.title ?? "",
              count: answer.count,
              selectionId: answer.selection_id,
              digest: answer.digest,
            },
      );
      try {
        await this.#deps.send(text);
      } catch {
        this.#say(s.sendFailed);
        return;
      }
      this.#sent = true;
      this.#renderSent();
    } finally {
      this.#busy = false;
      if (!this.#sent) this.#syncFooter();
    }
  }
}

/** A row's box: out of the tab order and the accessibility tree (the tree item carries aria-checked);
 *  a click toggles, then the sync puts it back as the model says (a refused tick unticks again). */
function checkbox(onToggle: () => void): HTMLInputElement {
  const box = el("input", { type: "checkbox", tabindex: "-1", "aria-hidden": "true" }) as HTMLInputElement;
  box.addEventListener("change", onToggle);
  // A press on the box focuses its tree item rather than the box, so the arrow keys keep working.
  box.addEventListener("mousedown", (event) => {
    event.preventDefault();
    (box.closest('[role="treeitem"]') as HTMLElement | null)?.focus();
  });
  return box;
}

function applyState(li: HTMLLIElement, box: HTMLInputElement, state: CheckState): void {
  box.checked = state === "checked";
  box.indeterminate = state === "mixed";
  box.disabled = state === "disabled";
  li.setAttribute("aria-checked", state === "checked" ? "true" : state === "mixed" ? "mixed" : "false");
  if (state === "disabled") li.setAttribute("aria-disabled", "true");
  else li.removeAttribute("aria-disabled");
}

/** The last segment of an absolute path, either separator. */
function rootName(root: string): string {
  return root.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) ?? "";
}

function field(id: string, label: (string | HTMLElement)[], control: HTMLElement, extra = ""): HTMLElement {
  return el("div", { class: `picker-field ${extra}`.trim() }, el("label", { for: id }, ...label), control);
}

function option(value: string, text: string): HTMLOptionElement {
  const o = el("option", {}, text) as HTMLOptionElement;
  o.value = value;
  return o;
}

/** An element with attributes and children; strings become text nodes, never markup. */
function el(tag: string, attrs: Record<string, string>, ...children: (string | globalThis.Node)[]): HTMLElement {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
  for (const child of children) element.append(typeof child === "string" ? document.createTextNode(child) : child);
  return element;
}
