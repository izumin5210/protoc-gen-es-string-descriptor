import { type DescFile, fromBinary, toBinary } from "@bufbuild/protobuf";
import { FileDescriptorProtoSchema } from "@bufbuild/protobuf/wkt";
import { hydrate } from "../hydrate.js";
import { type DescTree, fromTree } from "../option-b/runtime.js";
import { type NameEntry, restoreNames } from "./table.js";

/**
 * Generated code imports the lookups from here too.
 * @lintignore
 */
export { enumDesc, extDesc, messageDesc, serviceDesc } from "./runtime.js";

/**
 * The name-table variant of the names runtime: oneof members and public /
 * weak imports come in a third argument instead of inline markers.
 */
export function fileDesc(
  tree: DescTree,
  imports: DescFile[] = [],
  names: readonly NameEntry<DescFile>[] = [],
): DescFile {
  const file = fromBinary(FileDescriptorProtoSchema, fromTree(tree));
  restoreNames(file, names, imports);
  return hydrate(toBinary(FileDescriptorProtoSchema, file), imports);
}
