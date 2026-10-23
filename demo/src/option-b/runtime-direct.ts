import type { DescFile } from "@bufbuild/protobuf";
import { hydrate } from "../hydrate.js";
import { type DescTree, fromTree } from "./runtime.js";

/** Option B runtime without the base64 round trip of `./runtime.ts`. */
export function fileDesc(tree: DescTree, imports?: DescFile[]): DescFile {
  return hydrate(fromTree(tree), imports);
}
