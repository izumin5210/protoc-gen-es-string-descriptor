import { base64Decode } from "@bufbuild/protobuf/wire";
import { renderTree, toTree } from "./encode.js";

const CODEGEN_IMPORT_RE =
  /^import\s+\{([^}]+)\}\s+from\s+"@bufbuild\/protobuf\/codegenv[12]";[ \t]*$/gm;
const FILE_DESC_RE = /(fileDesc\()"([A-Za-z0-9+/=]+)"/g;

/**
 * Rewrite protoc-gen-es output so that `fileDesc` receives a length-less
 * tree, mirroring what `transformFileContent` in `src/transform.ts` does for
 * raw byte strings.
 */
export function transformFileContentToTree(
  content: string,
  runtimeModule: string,
): string {
  if (!content.includes("fileDesc(")) {
    return content;
  }
  const replaced = content.replace(
    FILE_DESC_RE,
    (_match, prefix: string, b64: string) =>
      `${prefix}[\n${renderTree(toTree(base64Decode(b64)))}\n]`,
  );
  return replaced.replace(CODEGEN_IMPORT_RE, (original, names: string) => {
    const nameList = names
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
    if (!nameList.includes("fileDesc")) {
      return original;
    }
    const remaining = nameList.filter((n) => n !== "fileDesc");
    const runtimeImport = `import { fileDesc } from "${runtimeModule}";`;
    if (remaining.length === 0) {
      return runtimeImport;
    }
    return `${original.replace(names, ` ${remaining.join(", ")} `)}\n${runtimeImport}`;
  });
}
