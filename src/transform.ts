import { base64Decode } from "@bufbuild/protobuf/wire";
import { escapeBytesAsJSString } from "./escape.js";
import { splitAfter } from "./split.js";

const RUNTIME_PACKAGE = "protoc-gen-es-string-descriptor/runtime";
const CODEGEN_IMPORT_RE =
  /^(import\s+\{)([^}]+)(\}\s+from\s+")(@bufbuild\/protobuf\/codegenv[12])(";\s*)$/gm;
const FILE_DESC_RE = /(fileDesc\()"([A-Za-z0-9+/=]+)"/g;

/**
 * Transform generated code: replace base64 fileDesc strings with
 * raw byte string literals split at 0x0a boundaries.
 */
export function transformFileContent(content: string): string {
  if (!content.includes("fileDesc(")) {
    return content;
  }

  let result = content;

  // Step 1: Transform fileDesc("base64") to fileDesc("raw escaped multiline")
  result = result.replace(
    FILE_DESC_RE,
    (_match, prefix: string, b64: string) => {
      const bytes = base64Decode(b64);
      const chunks = splitAfter(bytes, 0x0a);

      if (chunks.length <= 1) {
        return `${prefix}"${escapeBytesAsJSString(bytes)}"`;
      }

      const lines = chunks.map((chunk) => `"${escapeBytesAsJSString(chunk)}"`);
      return `${prefix}"" +\n${lines.map((line) => `    ${line}`).join(" +\n")}`;
    },
  );

  // Step 2: Rewrite import { fileDesc, ... } from "@bufbuild/protobuf/codegenvN"
  let needsRuntimeImport = false;

  result = result.replace(
    CODEGEN_IMPORT_RE,
    (
      original,
      importStart: string,
      names: string,
      fromStart: string,
      pkg: string,
      fromEnd: string,
    ) => {
      const nameList = names
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean);
      const hasFileDesc = nameList.includes("fileDesc");

      if (!hasFileDesc) {
        return original;
      }

      needsRuntimeImport = true;
      const remaining = nameList.filter((n) => n !== "fileDesc");

      if (remaining.length === 0) {
        return "";
      }

      return `${importStart} ${remaining.join(", ")} ${fromStart}${pkg}${fromEnd}`;
    },
  );

  if (needsRuntimeImport) {
    const runtimeImport = `import { fileDesc } from "${RUNTIME_PACKAGE}";\n`;
    const lastImportIndex = findLastImportEnd(result);
    if (lastImportIndex >= 0) {
      result =
        result.slice(0, lastImportIndex) +
        runtimeImport +
        result.slice(lastImportIndex);
    } else {
      result = runtimeImport + result;
    }
  }

  // Clean up empty lines from removed imports
  result = result.replace(/\n{3,}/g, "\n\n");

  return result;
}

function findLastImportEnd(content: string): number {
  const importRe = /^import\s.+;\s*$/gm;
  let lastIndex = -1;
  for (const match of content.matchAll(importRe)) {
    lastIndex = match.index + match[0].length + 1;
  }
  return lastIndex;
}
