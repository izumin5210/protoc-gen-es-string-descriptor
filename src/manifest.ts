import type { DescFile } from "@bufbuild/protobuf";
import { pathInFileDesc } from "@bufbuild/protobuf/codegenv2";
import { nestedTypes } from "@bufbuild/protobuf/reflect";

const HEADER = [
  "// Index manifest: every descriptor that the generated code looks up by",
  "// position (messageDesc, enumDesc, serviceDesc, extDesc), one per line as",
  '// "<path>: <kind> <full name>". If two branches renumber the same list,',
  "// these lines conflict instead of merging into silently wrong indices.",
];

/**
 * List the elements of a file in the order protoc-gen-es generates them,
 * with the same path it passes to `messageDesc(file, ...path)` and friends.
 */
export function indexManifest(file: DescFile): string[] {
  return [...nestedTypes(file)].map(
    (desc) =>
      `// ${pathInFileDesc(desc).join(".")}: ${desc.kind} ${desc.typeName}`,
  );
}

/**
 * Insert the manifest right after the `fileDesc(...)` statement. String
 * literals in the call never contain a raw line break, so the first `);` at
 * the end of a line closes it.
 */
export function insertIndexManifest(
  content: string,
  manifest: string[],
): string {
  if (manifest.length === 0) {
    return content;
  }
  const start = content.indexOf("fileDesc(");
  if (start < 0) {
    return content;
  }
  const end = content.indexOf(");\n", start);
  if (end < 0) {
    return content;
  }
  const at = end + ");\n".length;
  return `${content.slice(0, at)}\n${[...HEADER, ...manifest].join("\n")}\n${content.slice(at)}`;
}
