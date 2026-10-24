import type { DescFile } from "@bufbuild/protobuf";
import { jsStringToBytes } from "../../src/escape.js";
import { hydrate } from "./hydrate.js";

/** Option A runtime without the base64 round trip of `src/runtime.ts`. */
export function fileDesc(raw: string, imports?: DescFile[]): DescFile {
  return hydrate(jsStringToBytes(raw), imports);
}
