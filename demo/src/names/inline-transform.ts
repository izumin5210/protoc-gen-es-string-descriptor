import { clone, fromBinary, toBinary } from "@bufbuild/protobuf";
import { base64Decode } from "@bufbuild/protobuf/wire";
import {
  type DescriptorProto,
  type EnumDescriptorProto,
  type FileDescriptorProto,
  FileDescriptorProtoSchema,
} from "@bufbuild/protobuf/wkt";
import { equalBytes } from "../bytes.js";
import { renderTree, toTree } from "../option-b/encode.js";
import { embedInlineNames, restoreInlineNames } from "./inline.js";
import { elementNames, moveImports } from "./table-transform.js";

// Mirrors `src/transform.ts` of the plugin's names encoding (PR #14), for
// `target=ts`.
const FILE_DESC_RE = /fileDesc\("([A-Za-z0-9+/=]+)"(?:, \[([\w$, ]*)\])?\);\n/;
// Only the lines that protoc-gen-es generates, not comments or strings.
const DESC_CALL_RE =
  /^( {2}(messageDesc|enumDesc|serviceDesc|extDesc)\([\w$]+)((?:, \d+)+)\);$/gm;

export interface InlineOptions {
  /** The imported file names of the `.proto`, in import order. */
  dependency: readonly string[];
  /** Emit number types. */
  numberTypes: boolean;
}

/**
 * Rewrite protoc-gen-es output:
 *
 * - `fileDesc("base64", [deps])` becomes `fileDesc(tree, [deps])`, where
 *   `tree` is the descriptor as a length-less nested array that marks real
 *   oneof members and public / weak imports by name, and `deps` has one
 *   import per line;
 * - `messageDesc(file, 0, 1)` & co refer to the element by name;
 * - with `numberTypes`, a type keyed by number is emitted per message and
 *   enum after `fileDesc(...)`.
 */
export function transformFileContentInline(
  content: string,
  runtimeModule: string,
  { dependency, numberTypes }: InlineOptions,
): string {
  const match = FILE_DESC_RE.exec(content);
  if (match === null) {
    return content;
  }
  const [statement, b64, deps = ""] = match;
  const bytes = base64Decode(b64);
  const imports = deps
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const embedded = fromBinary(FileDescriptorProtoSchema, bytes);
  const types = numberTypes ? renderNumberTypes(embedded) : "";
  const paths = elementNames(embedded);
  const args = renderFileDescArgs(bytes, embedded, imports, dependency);
  const replaced = `fileDesc(${args});\n${types}`;
  const body =
    `${content.slice(0, match.index)}${replaced}${content.slice(match.index + statement.length)}`.replace(
      DESC_CALL_RE,
      (call, head: string, fn: keyof typeof paths, path: string) => {
        const name = paths[fn].get(path.slice(2).replaceAll(" ", ""));
        if (name === undefined) {
          throw new Error(`no element for ${call.trim()}`);
        }
        return `${head}, ${JSON.stringify(name)});`;
      },
    );
  return moveImports(
    body,
    ["fileDesc", "messageDesc", "enumDesc", "serviceDesc", "extDesc"],
    runtimeModule,
  );
}

function renderFileDescArgs(
  bytes: Uint8Array,
  embedded: FileDescriptorProto,
  imports: string[],
  dependency: readonly string[],
): string {
  const file = clone(FileDescriptorProtoSchema, embedded);
  embedInlineNames(file, dependency);
  const encoded = toBinary(FileDescriptorProtoSchema, file);
  assertRestorable(bytes, embedded.name, encoded, dependency);
  const tree = toTree(encoded, FileDescriptorProtoSchema, {
    unknownOnOwnLine: true,
  });
  return [
    "[",
    renderTree(tree),
    "], [",
    ...imports.map((name) => ` ${name},`),
    "]",
  ].join("\n");
}

/**
 * Restore the descriptor as the runtime will, and fail rather than emit
 * something that hydrates differently.
 */
function assertRestorable(
  bytes: Uint8Array,
  fileName: string,
  encoded: Uint8Array,
  dependency: readonly string[],
): void {
  const restored = fromBinary(FileDescriptorProtoSchema, encoded);
  restored.dependency = [...dependency];
  restoreInlineNames(restored);
  // protoc-gen-es leaves the imports out of the embedded descriptor.
  restored.dependency = [];
  if (!equalBytes(toBinary(FileDescriptorProtoSchema, restored), bytes)) {
    throw new Error(`${fileName}: the descriptor does not round-trip`);
  }
}

/**
 * One exported type per message and enum, keyed by field or value number.
 * Two equal numbers make TypeScript report TS2300 (duplicate identifier);
 * the types are erased from JavaScript. Map entries and enums with
 * `allow_alias` are left out.
 */
function renderNumberTypes(file: FileDescriptorProto): string {
  const lines: string[] = [];
  const taken = new Set<string>();
  const emit = (scope: string, entries: [number, string][]) => {
    // A nested `Outer.Inner` and a top-level `Outer_Inner` would share a
    // name; protoc-gen-es resolves the same clash with `$`.
    let name = scope;
    while (taken.has(name)) {
      name += "$";
    }
    taken.add(name);
    lines.push(
      `export type ${name} = {`,
      // A negative number is not a valid property name unquoted.
      ...entries.map(
        ([n, v]) => `  ${n < 0 ? `"${n}"` : n}: ${JSON.stringify(v)};`,
      ),
      "};",
    );
  };
  const enumType = (e: EnumDescriptorProto, scope: string) => {
    if (e.options?.allowAlias !== true) {
      emit(
        `${scope}_${e.name}`,
        e.value.map((v) => [v.number, v.name]),
      );
    }
  };
  const walk = (list: DescriptorProto[], scope: string) => {
    for (const m of list.filter((m) => m.options?.mapEntry !== true)) {
      const name = `${scope}_${m.name}`;
      emit(
        name,
        m.field.map((f) => [f.number, f.name]),
      );
      for (const e of m.enumType) {
        enumType(e, name);
      }
      walk(m.nestedType, name);
    }
  };
  const scope = ["_numbers", ...file.package.split(".").filter(Boolean)].join(
    "_",
  );
  walk(file.messageType, scope);
  for (const e of file.enumType) {
    enumType(e, scope);
  }
  return lines.map((line) => `${line}\n`).join("");
}
