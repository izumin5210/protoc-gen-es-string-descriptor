import type {
  DescEnum,
  DescExtension,
  DescFile,
  DescMessage,
  DescService,
} from "@bufbuild/protobuf";
import { pathInFileDesc } from "@bufbuild/protobuf/codegenv2";
import { nestedTypes } from "@bufbuild/protobuf/reflect";

export interface ManifestOptions {
  /**
   * Also list what the embedded descriptor refers to by position: imports
   * (public_dependency, weak_dependency) and oneofs (oneof_index).
   */
  descriptorIndices: boolean;
}

type IndexedDesc = DescMessage | DescEnum | DescService | DescExtension;

/**
 * One block per list, each headed by a line that names the list but not its
 * position, so that edits at the end of one list and the start of the next
 * don't touch. The wrapper feature emits the blocks of generated-code
 * references; `descriptorIndices` adds the blocks proposed upstream.
 */
export function indexManifest(
  file: DescFile,
  { descriptorIndices }: ManifestOptions,
): string[] {
  const lines: string[] = [];
  const block = (header: string, entries: string[]) => {
    if (entries.length > 0) {
      lines.push(`// ${header}:`, ...entries.map((entry) => `// ${entry}`));
    }
  };
  const descs = (list: IndexedDesc[]) =>
    list.map(
      (desc) =>
        `${pathInFileDesc(desc).join(".")}: ${desc.kind} ${desc.typeName}`,
    );
  if (descriptorIndices) {
    // protobuf-es rebuilds `dependency` from the imports array in this order,
    // and public_dependency / weak_dependency index into it.
    block(
      "imports",
      file.proto.dependency.map((name, i) => {
        const flag = file.proto.publicDependency.includes(i)
          ? " (public)"
          : file.proto.weakDependency.includes(i)
            ? " (weak)"
            : "";
        return `${i}: ${name}${flag}`;
      }),
    );
  }
  block("top-level messages", descs(file.messages));
  for (const desc of nestedTypes(file)) {
    if (desc.kind === "message") {
      block(`messages nested in ${desc.typeName}`, descs(desc.nestedMessages));
      block(`enums nested in ${desc.typeName}`, descs(desc.nestedEnums));
      block(
        `extensions nested in ${desc.typeName}`,
        descs(desc.nestedExtensions),
      );
      if (descriptorIndices) {
        // oneof_index of each field points into oneof_decl, which includes
        // the synthetic oneofs of proto3 optional fields.
        block(
          `oneofs of ${desc.typeName}`,
          desc.proto.oneofDecl.map((oneof, i) => `${i}: ${oneof.name}`),
        );
      }
    }
  }
  block("top-level enums", descs(file.enums));
  block("services", descs(file.services));
  block("top-level extensions", descs(file.extensions));
  return lines;
}

const HEADER = [
  "// Index manifest: every position that the generated code or the embedded",
  "// descriptor refers to, one block per list and one line per element. If",
  "// two branches renumber the same list, these lines conflict instead of",
  "// merging into silently wrong indices.",
];

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
