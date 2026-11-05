// The project picker widget, rendered by the host from ui://dikigoros/project-picker. This file only
// wires the MCP Apps bridge to the view: show_project_picker's result names the scan; the app-only
// load_picker returns the full tree (kept out of the tool result, which the model reads too), which
// view.ts renders; the view's save goes to the app-only save_selection and its confirmation to the
// chat as the lawyer's message. Theme, style variables, fonts and language follow the host context.

import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type {
  LoadPickerArgs,
  PickerInput,
  SaveSelectionArgs,
  SaveSelectionRefusal,
  SaveSelectionResult,
} from "../shared/picker-contract";
import { stringsFor } from "./strings";
import { mountPicker, type PickerHandle, showMessage } from "./view";

/** Defined by scripts/build.ts; absent under the tests, which call startPicker themselves. */
declare const PLUGIN_VERSION: string | undefined;

/** What the picker needs of the App; the tests hand it a real App connected to an AppBridge. */
export type PickerApp = Pick<App, "addEventListener" | "getHostContext" | "callServerTool" | "sendMessage" | "connect">;

type ToolResult = Awaited<ReturnType<App["callServerTool"]>>;

/**
 * Starts the picker in `root`: listens for the tool result and the host context (before connecting,
 * so neither is missed), connects over `transport` (the App's default, window.parent, when omitted),
 * and renders once load_picker has answered.
 */
export async function startPicker(app: PickerApp, root: HTMLElement, transport?: Parameters<App["connect"]>[0]): Promise<void> {
  let locale: string | undefined;
  let picker: PickerHandle | null = null;
  let scanId: string | null = null;
  /** The message shown while there is no picker, re-shown in the host's language when it changes. */
  let status: "waiting" | "loading" | "expired" | "loadFailed" = "waiting";
  const show = (next: typeof status) => {
    status = next;
    picker = null;
    showMessage(root, stringsFor(locale)[next]);
  };
  show("waiting");

  const applyContext = (context: McpUiHostContext | undefined) => {
    if (context === undefined) return;
    if (context.theme !== undefined) applyDocumentTheme(context.theme);
    if (context.styles?.variables !== undefined) applyHostStyleVariables(context.styles.variables);
    if (context.styles?.css?.fonts !== undefined) applyHostFonts(context.styles.css.fonts);
    if (typeof context.locale === "string") locale = context.locale;
    if (picker !== null) picker.setLocale(locale);
    else show(status);
  };

  const load = async (id: string) => {
    show("loading");
    const args: LoadPickerArgs = { scan_id: id };
    let result: ToolResult;
    try {
      result = await app.callServerTool({ name: "load_picker", arguments: { ...args } });
    } catch {
      if (scanId === id) show("loadFailed");
      return;
    }
    if (scanId !== id) return; // a newer tool result took over
    if (result.isError === true) return show("expired");
    if (!isPickerInput(result.structuredContent)) return show("loadFailed");
    picker = mountPicker(root, result.structuredContent, {
      locale,
      save: (selection) => save(app, selection),
      send: async (text) => {
        const answer = await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
        if (answer.isError === true) throw new Error("the host refused the message");
      },
    });
  };

  app.addEventListener("hostcontextchanged", () => applyContext(app.getHostContext()));
  app.addEventListener("toolresult", (result) => {
    const id = isRecord(result.structuredContent) ? result.structuredContent.scan_id : undefined;
    if (typeof id !== "string" || id === "" || id === scanId) return;
    scanId = id;
    void load(id);
  });

  await app.connect(transport);
  applyContext(app.getHostContext());
}

/** save_selection over the bridge: its answer, or a throw when the call failed without a refusal. */
async function save(app: PickerApp, args: SaveSelectionArgs): Promise<SaveSelectionResult | SaveSelectionRefusal> {
  const result = await app.callServerTool({ name: "save_selection", arguments: { ...args } });
  const content = result.structuredContent;
  if (isRecord(content) && typeof content.refused === "string") return content as unknown as SaveSelectionRefusal;
  if (result.isError === true) throw new Error("save_selection failed");
  if (isRecord(content) && typeof content.selection_id === "string" && typeof content.digest === "string") {
    return content as unknown as SaveSelectionResult;
  }
  throw new Error("save_selection answered no selection");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The shape view.ts relies on; the helper is trusted, this only keeps a broken answer from crashing the view. */
function isPickerInput(value: unknown): value is PickerInput {
  return (
    isRecord(value) &&
    typeof value.scan_id === "string" &&
    (value.mode === "new" || value.mode === "linked") &&
    typeof value.root === "string" &&
    typeof value.room === "number" &&
    typeof value.held === "number" &&
    Array.isArray(value.preselect) &&
    Array.isArray(value.folders) &&
    Array.isArray(value.files) &&
    value.files.every((file) => isRecord(file) && typeof file.path === "string" && typeof file.name === "string")
  );
}

if (typeof PLUGIN_VERSION === "string") {
  const root = document.getElementById("app");
  if (root !== null) void startPicker(new App({ name: "dikigoros-project-picker", version: PLUGIN_VERSION }), root);
}
