import { clone, fromBinary, toBinary } from "@bufbuild/protobuf";
import { base64Decode } from "@bufbuild/protobuf/wire";
import {
  type DescriptorProto,
  type EnumDescriptorProto,
  type FileDescriptorProto,
  FileDescriptorProtoSchema,
} from "@bufbuild/protobuf/wkt";
import { extractNames, type NameEntry, restoreNames } from "./names.js";
import {
  evaluateTree,
  fromTree,
  renderTree,
  type TreeItem,
  toTree,
} from "./tree.js";

const RUNTIME_PACKAGE = "protoc-gen-es-string-descriptor";
const FILE_DESC_RE = /fileDesc\("([A-Za-z0-9+/=]+)"(?:, \[([\w$, ]*)\])?\);\n/;
const FILE_DECL_RE = /^export declare const [\w$]+: GenFile;\n/m;
const DESC_CALL_RE =
  /\b(messageDesc|enumDesc|serviceDesc|extDesc)\(([\w$]+)((?:, \d+)+)\)/g;
const CODEGEN_IMPORT_RE =
  /^import \{([^}]+)\} from "@bufbuild\/protobuf\/codegenv[12]";$/m;
const MOVED_IMPORTS = [
  "fileDesc",
  "messageDesc",
  "enumDesc",
  "serviceDesc",
  "extDesc",
];

/**
 * Rewrite protoc-gen-es output:
 *
 * - `fileDesc("base64", [deps])` becomes `fileDesc(tree, deps, names)`, where
 *   `tree` is the descriptor as a length-less nested array, `deps` has one
 *   import per line, and `names` refers by name to what the descriptor says
 *   by position;
 * - `messageDesc(file, 0, 1)` & co refer to the element by name;
 * - with `numberTypesFor`, a type keyed by number is emitted per message and
 *   enum, after `fileDesc(...)` in `.ts` and after the `GenFile` declaration
 *   in `.d.ts`.
 */
export function transformFileContent(
  content: string,
  numberTypesFor?: FileDescriptorProto,
): string {
  const match = FILE_DESC_RE.exec(content);
  if (match !== null) {
    const [statement, b64, deps = ""] = match;
    const bytes = base64Decode(b64);
    const imports = deps
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const embedded = fromBinary(FileDescriptorProtoSchema, bytes);
    const paths = elementNames(embedded);
    const replaced = `fileDesc(${renderFileDescArgs(bytes, embedded, imports)});\n${renderNumberTypes(numberTypesFor)}`;
    const body =
      `${content.slice(0, match.index)}${replaced}${content.slice(match.index + statement.length)}`.replace(
        DESC_CALL_RE,
        (call, fn: keyof typeof paths, fileVar: string, path: string) => {
          const name = paths[fn].get(path.slice(2).replaceAll(" ", ""));
          if (name === undefined) {
            throw new Error(`no element for ${call}`);
          }
          return `${fn}(${fileVar}, ${JSON.stringify(name)})`;
        },
      );
    return moveImports(body);
  }
  const decl = FILE_DECL_RE.exec(content);
  if (decl !== null && numberTypesFor !== undefined) {
    const end = decl.index + decl[0].length;
    return `${content.slice(0, end)}${renderNumberTypes(numberTypesFor)}${content.slice(end)}`;
  }
  return content;
}

function renderFileDescArgs(
  bytes: Uint8Array,
  embedded: FileDescriptorProto,
  imports: string[],
): string {
  const file = clone(FileDescriptorProtoSchema, embedded);
  const names = extractNames(file, imports);
  const tree = toTree(toBinary(FileDescriptorProtoSchema, file));
  assertRestorable(bytes, embedded.name, tree, names, imports);
  const entries = names.map(([kind, ...rest]) => {
    // Imports are referred to by the identifier of the imported file.
    const args = kind === "oneof" ? rest.map((s) => JSON.stringify(s)) : rest;
    return ` [${[JSON.stringify(kind), ...args].join(", ")}],`;
  });
  return [
    "[",
    ...renderTree(tree),
    "], [",
    ...imports.map((name) => ` ${name},`),
    "], [",
    ...entries,
    "]",
  ].join("\n");
}

/**
 * Restore the descriptor as the runtime will, and fail generation rather than
 * emit something that hydrates differently, e.g. if a compiler names
 * synthetic oneofs unlike protoc.
 */
function assertRestorable(
  bytes: Uint8Array,
  fileName: string,
  tree: TreeItem[],
  names: NameEntry<string>[],
  imports: string[],
): void {
  const restored = fromBinary(
    FileDescriptorProtoSchema,
    fromTree(evaluateTree(tree)),
  );
  restoreNames(restored, names, imports);
  const actual = toBinary(FileDescriptorProtoSchema, restored);
  if (
    actual.length !== bytes.length ||
    actual.some((byte, i) => byte !== bytes[i])
  ) {
    throw new Error(`${fileName}: the descriptor does not round-trip`);
  }
}

/**
 * Names relative to the package, keyed by the path that generated code
 * passes to `messageDesc` & co. Map entries are not counted, as in
 * protobuf-es's registry.
 */
function elementNames(file: FileDescriptorProto) {
  const names = {
    messageDesc: new Map<string, string>(),
    enumDesc: new Map<string, string>(),
    serviceDesc: new Map<string, string>(),
    extDesc: new Map<string, string>(),
  };
  const add = (
    map: Map<string, string>,
    list: { name: string }[],
    path: number[],
    prefix: string,
  ) => {
    for (const [i, element] of list.entries()) {
      map.set([...path, i].join(","), `${prefix}${element.name}`);
    }
  };
  add(names.serviceDesc, file.service, [], "");
  add(names.enumDesc, file.enumType, [], "");
  add(names.extDesc, file.extension, [], "");
  const walk = (list: DescriptorProto[], path: number[], prefix: string) => {
    const messages = list.filter((m) => m.options?.mapEntry !== true);
    for (const [i, m] of messages.entries()) {
      const p = [...path, i];
      const name = `${prefix}${m.name}`;
      names.messageDesc.set(p.join(","), name);
      add(names.enumDesc, m.enumType, p, `${name}.`);
      add(names.extDesc, m.extension, p, `${name}.`);
      walk(m.nestedType, p, `${name}.`);
    }
  };
  walk(file.messageType, [], "");
  return names;
}

/**
 * One exported type per message and enum, keyed by field or value number.
 * Two equal numbers make TypeScript report TS2300 (duplicate identifier);
 * the types are erased from JavaScript. Map entries and enums with
 * `allow_alias` are left out. Exported so that `noUnusedLocals` allows them.
 */
function renderNumberTypes(file: FileDescriptorProto | undefined): string {
  if (file === undefined) {
    return "";
  }
  const lines: string[] = [];
  const taken = new Set<string>();
  const emit = (scope: string, entries: [number, string][]) => {
    // A nested `Outer.Inner` and a top-level `Outer_Inner` would share a
    // name; protoc-gen-es resolves the same clash with `$`.
    let name = `_numbers_${scope}`;
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
  const scope = file.package.replaceAll(".", "_");
  walk(file.messageType, scope);
  for (const e of file.enumType) {
    enumType(e, scope);
  }
  return lines.map((line) => `${line}\n`).join("");
}

/** Import {@link MOVED_IMPORTS} from this package instead of codegenv2. */
function moveImports(content: string): string {
  return content.replace(CODEGEN_IMPORT_RE, (original, list: string) => {
    const all = list
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
    const moved = all.filter((n) => MOVED_IMPORTS.includes(n));
    const kept = all.filter((n) => !MOVED_IMPORTS.includes(n));
    if (moved.length === 0) {
      return original;
    }
    const runtimeImport = `import { ${moved.join(", ")} } from "${RUNTIME_PACKAGE}";`;
    if (kept.length === 0) {
      return runtimeImport;
    }
    return `${original.replace(list, ` ${kept.join(", ")} `)}\n${runtimeImport}`;
  });
}
