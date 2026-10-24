// Loads the installed native packages through Node's own resolution, from the node_modules
// directory ensureNativeRuntime returned: each JS package's loader then finds its platform package
// beside it. The canvas interfaces are the part of @napi-rs/canvas the PDF extraction uses, typed
// structurally so that a fake module satisfies them.

import { createRequire } from "node:module";
import { join } from "node:path";
import type { KeyringBinding } from "../auth/token-store";

export interface CanvasContextLike {
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
}

export interface CanvasLike {
  width: number;
  height: number;
  getContext(type: "2d", attrs?: object): CanvasContextLike;
  encode(format: "jpeg", quality: number): Promise<Buffer>;
}

export interface CanvasModule {
  createCanvas(width: number, height: number): CanvasLike;
  /** Constructors pdf.js needs as globals; src/extract/pdf.ts installs them. */
  DOMMatrix: unknown;
  Path2D: unknown;
  ImageData: unknown;
}

export function loadCanvasModule(nodeModulesDir: string): CanvasModule {
  return requireFrom(nodeModulesDir)("@napi-rs/canvas") as CanvasModule;
}

export function loadKeyringBinding(nodeModulesDir: string): KeyringBinding {
  return requireFrom(nodeModulesDir)("@napi-rs/keyring") as KeyringBinding;
}

/** A require that resolves as a module inside `nodeModulesDir` would (the file need not exist). */
function requireFrom(nodeModulesDir: string): NodeJS.Require {
  return createRequire(join(nodeModulesDir, "_.cjs"));
}
