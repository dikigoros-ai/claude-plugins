// An in-process MCP Apps host for the picker's DOM tests: a real AppBridge (the host side of
// @modelcontextprotocol/ext-apps) and a real App, each on the SDK's own PostMessageTransport. Both
// live in one happy-dom window, so the pair of "windows" they post to are two small stand-ins that
// dispatch a MessageEvent on that window with the other side as its source: each transport then
// takes only the other side's messages, as it would across a real iframe boundary. The host answers
// tools/call from stubs (load_picker, save_selection), records every tool call and ui/message, and
// delivers a tool result once the widget has initialised.

import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";
import { AppBridge, type McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge";
import { startPicker } from "../../src/ui/main";

type CallToolResult = Parameters<AppBridge["sendToolResult"]>[0];
type ToolCall = { name: string; arguments: Record<string, unknown> | undefined };
type Message = { role: string; content: unknown[] };

export interface UiHost {
  app: App;
  bridge: AppBridge;
  /** Resolves once the widget sent ui/notifications/initialized. */
  initialized: Promise<void>;
  /** Every tools/call the widget made, in order. */
  calls: ToolCall[];
  /** Every ui/message the widget sent, in order. */
  messages: Message[];
  /** Sends show_project_picker's result to the widget. */
  deliverToolResult(result: CallToolResult): Promise<void>;
  close(): Promise<void>;
}

export interface UiHostOptions {
  hostContext?: McpUiHostContext;
  /** Answers a tools/call; the default answers isError for every tool. */
  onTool?: (call: ToolCall) => CallToolResult | Promise<CallToolResult>;
}

/** A window stand-in: postMessage dispatches on the real window, as if sent by `source`. */
function postTo(source: object): Window {
  return {
    postMessage(data: unknown) {
      const copy = structuredClone(data);
      setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: copy, source: source as Window })), 0);
    },
  } as unknown as Window;
}

/** Starts the host and the picker in `root`. */
export async function startUiHost(root: HTMLElement, options: UiHostOptions = {}): Promise<UiHost> {
  const appSide = {};
  const hostSide = {};
  const calls: ToolCall[] = [];
  const messages: Message[] = [];
  const bridge = new AppBridge(
    null,
    { name: "test-host", version: "1.0.0" },
    { serverTools: {}, message: { text: {} } },
    { hostContext: options.hostContext ?? { theme: "light", locale: "en-GB" } },
  );
  bridge.oncalltool = async (params) => {
    const call = { name: params.name, arguments: params.arguments };
    calls.push(call);
    if (options.onTool !== undefined) return options.onTool(call);
    return { isError: true, content: [{ type: "text", text: `no stub for ${params.name}` }] };
  };
  bridge.onmessage = async (params) => {
    messages.push(params as Message);
    return {};
  };
  const initialized = new Promise<void>((resolve) => {
    bridge.oninitialized = () => resolve();
  });
  // The host's transport sends as hostSide and takes what appSide sends; the App's the other way round.
  await bridge.connect(new PostMessageTransport(postTo(hostSide), appSide as Window));
  const app = new App({ name: "dikigoros-project-picker", version: "test" }, {}, { autoResize: false });
  const started = startPicker(app, root, new PostMessageTransport(postTo(appSide), hostSide as Window));
  await started;
  await initialized;
  return {
    app,
    bridge,
    initialized,
    calls,
    messages,
    deliverToolResult: (result) => bridge.sendToolResult(result),
    async close() {
      await app.close();
      await bridge.close();
    },
  };
}
