import type {
  DescEnum,
  DescExtension,
  DescFile,
  DescMessage,
  DescService,
} from "@bufbuild/protobuf";
import { pathInFileDesc } from "@bufbuild/protobuf/codegenv2";
import { nestedTypes } from "@bufbuild/protobuf/reflect";

// Mirrors src/manifest.ts of the index manifest feature, which this demo
// does not depend on so that both can be reviewed independently.
const HEADER = [
  "// Index manifest: every descriptor that the generated code looks up by",
  "// position (messageDesc, enumDesc, serviceDesc, extDesc), one block per",
  '// list and one line per element as "<path>: <kind> <full name>". If two',
  "// branches renumber the same list, these lines conflict instead of",
  "// merging into silently wrong indices.",
];

/**
 * One block per list that generated code indexes into, each headed by a line
 * that names the list but not its position. The header keeps edits at the
 * end of one list and the start of the next from touching each other.
 */
export function indexManifest(file: DescFile): string[] {
  const lines: string[] = [];
  const block = (
    header: string,
    descs: (DescMessage | DescEnum | DescService | DescExtension)[],
  ) => {
    if (descs.length === 0) {
      return;
    }
    lines.push(`// ${header}:`);
    for (const desc of descs) {
      lines.push(
        `// ${pathInFileDesc(desc).join(".")}: ${desc.kind} ${desc.typeName}`,
      );
    }
  };
  block("top-level messages", file.messages);
  for (const desc of nestedTypes(file)) {
    if (desc.kind === "message") {
      block(`messages nested in ${desc.typeName}`, desc.nestedMessages);
      block(`enums nested in ${desc.typeName}`, desc.nestedEnums);
      block(`extensions nested in ${desc.typeName}`, desc.nestedExtensions);
    }
  }
  block("top-level enums", file.enums);
  block("services", file.services);
  block("top-level extensions", file.extensions);
  return lines;
}

/** Insert the manifest right after the `fileDesc(...)` statement. */
export function insertIndexManifest(
  content: string,
  manifest: string[],
): string {
  const start = content.indexOf("fileDesc(");
  const end = start < 0 ? -1 : content.indexOf(");\n", start);
  if (manifest.length === 0 || end < 0) {
    return content;
  }
  const at = end + ");\n".length;
  return `${content.slice(0, at)}\n${[...HEADER, ...manifest].join("\n")}\n${content.slice(at)}`;
}
