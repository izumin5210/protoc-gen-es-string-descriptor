import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { base64Decode } from "@bufbuild/protobuf/wire";
import {
  type DescriptorProto,
  type EnumDescriptorProto,
  type FileDescriptorProto,
  FileDescriptorProtoSchema,
} from "@bufbuild/protobuf/wkt";
import { renderTree, toTree } from "../option-b/encode.js";
import { extractNames, stripSyntheticOneofs } from "./restore.js";

export interface NamesOptions {
  /**
   * Refer to elements by name: in `messageDesc(file, "Outer.Inner")` & co,
   * for oneof members and for public / weak imports. Without it, only the
   * synthetic oneofs are left out and everything else stays positional.
   */
  names: boolean;
  /** Emit a type keyed by number per message and enum. */
  numberTypes: boolean;
  /** Comment lines to insert after the `fileDesc(...)` statement. */
  manifest?: string[];
}

const FILE_DESC_RE = /fileDesc\("([A-Za-z0-9+/=]+)"(?:, \[([\w$, ]*)\])?\);\n/;
const DESC_CALL_RE =
  /\b(messageDesc|enumDesc|serviceDesc|extDesc)\((file_\w+)((?:, \d+)+)\)/g;
const CODEGEN_IMPORT_RE =
  /^import\s+\{([^}]+)\}\s+from\s+"@bufbuild\/protobuf\/codegenv[12]";[ \t]*$/m;

/**
 * Rewrite protoc-gen-es output so that `fileDesc` receives a length-less
 * tree without synthetic oneofs, one import per line, and (with `names`)
 * a table of what the descriptor would otherwise say by position.
 */
export function transformFileContentToNames(
  content: string,
  runtimeModule: string,
  options: NamesOptions,
): string {
  const match = FILE_DESC_RE.exec(content);
  if (match === null) {
    return content;
  }
  const bytes = base64Decode(match[1]);
  const imports = (match[2] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const original = fromBinary(FileDescriptorProtoSchema, bytes);
  const file = fromBinary(FileDescriptorProtoSchema, bytes);
  let names: ReturnType<typeof extractNames<string>> = [];
  if (options.names) {
    names = extractNames(file, imports);
  } else {
    file.messageType.forEach(stripSyntheticOneofs);
  }
  const tree = toTree(toBinary(FileDescriptorProtoSchema, file));
  // Comments only matter when public_dependency / weak_dependency still
  // point into this list by position.
  const numbered =
    !options.names &&
    (original.publicDependency.length > 0 ||
      original.weakDependency.length > 0);
  const importLines = imports.map((name, i) => {
    if (!numbered) {
      return `  ${name},`;
    }
    const flags = [
      original.publicDependency.includes(i) ? " public" : "",
      original.weakDependency.includes(i) ? " weak" : "",
    ].join("");
    return `  ${name}, // ${i}${flags}`;
  });
  const args = [`[\n${renderTree(tree)}\n]`];
  if (imports.length > 0 || names.length > 0) {
    args.push(imports.length > 0 ? `[\n${importLines.join("\n")}\n]` : "[]");
  }
  if (names.length > 0) {
    const entries = names.map(([kind, ...rest]) => {
      // Imports are referenced as the imported file objects.
      const args = kind === "oneof" ? rest.map((s) => JSON.stringify(s)) : rest;
      return `  [${[JSON.stringify(kind), ...args].join(", ")}],`;
    });
    args.push(`[\n${entries.join("\n")}\n]`);
  }
  const after = [
    ...(options.manifest ?? []),
    ...(options.numberTypes ? numberTypes(original) : []),
  ];
  let result = `${content.slice(0, match.index)}fileDesc(${args.join(", ")});\n${after.map((line) => `${line}\n`).join("")}${content.slice(match.index + match[0].length)}`;
  const moved = ["fileDesc"];
  if (options.names) {
    const paths = elementNames(original);
    result = result.replace(
      DESC_CALL_RE,
      (call, fn: keyof typeof paths, fileVar: string, path: string) => {
        const name = paths[fn].get(path.slice(2).replaceAll(" ", ""));
        if (name === undefined) {
          throw new Error(`no element for ${call}`);
        }
        return `${fn}(${fileVar}, ${JSON.stringify(name)})`;
      },
    );
    moved.push("messageDesc", "enumDesc", "serviceDesc", "extDesc");
  }
  return moveImports(result, moved, runtimeModule);
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
 * One type per message and enum, keyed by field or value number. Two equal
 * numbers make TypeScript report TS2300 (duplicate identifier); the types
 * are erased from JavaScript. Enums with `allow_alias` are left out.
 */
function numberTypes(file: FileDescriptorProto): string[] {
  const lines: string[] = [];
  const emit = (name: string, entries: [number, string][]) => {
    lines.push(
      `type _numbers_${name} = {`,
      ...entries.map(([n, v]) => `  ${n}: ${JSON.stringify(v)};`),
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
  return lines;
}

/** Import `names` from `module` instead of `@bufbuild/protobuf/codegenv2`. */
function moveImports(content: string, names: string[], module: string) {
  return content.replace(CODEGEN_IMPORT_RE, (original, list: string) => {
    const all = list
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
    const moved = all.filter((n) => names.includes(n));
    const kept = all.filter((n) => !names.includes(n));
    const runtimeImport = `import { ${moved.join(", ")} } from "${module}";`;
    if (moved.length === 0) {
      return original;
    }
    if (kept.length === 0) {
      return runtimeImport;
    }
    return `${original.replace(list, ` ${kept.join(", ")} `)}\n${runtimeImport}`;
  });
}
