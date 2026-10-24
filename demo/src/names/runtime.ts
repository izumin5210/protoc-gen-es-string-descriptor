import type {
  DescEnum,
  DescExtension,
  DescFile,
  DescMessage,
  DescService,
  JsonValue,
  Message,
} from "@bufbuild/protobuf";
import {
  fileDesc as codegenFileDesc,
  enumDesc as enumDescByIndex,
  extDesc as extDescByIndex,
  type GenEnum,
  type GenExtension,
  type GenMessage,
  type GenService,
  type GenServiceMethods,
  messageDesc as messageDescByIndex,
  serviceDesc as serviceDescByIndex,
} from "@bufbuild/protobuf/codegenv2";
import { nestedTypes } from "@bufbuild/protobuf/reflect";
import { base64Encode } from "@bufbuild/protobuf/wire";
import type { DescTree } from "../option-b/runtime.js";
import { fromNamedTree } from "./decode.js";

/**
 * Hydrate a file descriptor from a nested array in which real oneof members
 * and public / weak imports are marked by name and synthetic oneofs are left
 * out. The markers are resolved while the bytes are rebuilt, and the bytes
 * go to `fileDesc` from `@bufbuild/protobuf/codegenv2` as base64, so that
 * hydration is exactly upstream's.
 */
export function fileDesc(tree: DescTree, imports: DescFile[] = []): DescFile {
  const bytes = fromNamedTree(
    tree,
    imports.map((f) => f.proto.name),
  );
  return codegenFileDesc(base64Encode(bytes, "std_raw"), imports);
}

type AnyDesc = DescMessage | DescEnum | DescService | DescExtension;

const byName = new WeakMap<DescFile, Map<string, AnyDesc>>();

/** Every element of a file by its name relative to the package. */
export function elementsByName(file: DescFile): Map<string, AnyDesc> {
  const prefix = file.proto.package === "" ? "" : `${file.proto.package}.`;
  const map = new Map<string, AnyDesc>();
  for (const desc of nestedTypes(file)) {
    map.set(desc.typeName.slice(prefix.length), desc);
  }
  return map;
}

/**
 * Look an element up by its name relative to the package, e.g.
 * "Outer.Inner", from a map built on first use per file.
 */
function lookup<K extends AnyDesc["kind"]>(
  file: DescFile,
  kind: K,
  name: string,
): Extract<AnyDesc, { kind: K }> {
  let map = byName.get(file);
  if (map === undefined) {
    map = elementsByName(file);
    byName.set(file, map);
  }
  const desc = map.get(name);
  if (desc?.kind !== kind) {
    throw new Error(`${kind} ${name} not found in ${file.proto.name}`);
  }
  return desc as Extract<AnyDesc, { kind: K }>;
}

export function messageDesc<
  Shape extends Message,
  Opt extends { jsonType?: unknown; validType?: unknown } = {
    jsonType: undefined;
    validType: undefined;
  },
>(
  file: DescFile,
  nameOrPath: string | number,
  ...paths: number[]
): GenMessage<Shape, Opt> {
  return typeof nameOrPath === "string"
    ? (lookup(file, "message", nameOrPath) as GenMessage<Shape, Opt>)
    : messageDescByIndex(file, nameOrPath, ...paths);
}

export function enumDesc<
  Shape extends number,
  JsonType extends JsonValue = JsonValue,
>(
  file: DescFile,
  nameOrPath: string | number,
  ...paths: number[]
): GenEnum<Shape, JsonType> {
  return typeof nameOrPath === "string"
    ? (lookup(file, "enum", nameOrPath) as GenEnum<Shape, JsonType>)
    : enumDescByIndex(file, nameOrPath, ...paths);
}

export function serviceDesc<T extends GenServiceMethods>(
  file: DescFile,
  nameOrPath: string | number,
  ...paths: number[]
): GenService<T> {
  return typeof nameOrPath === "string"
    ? (lookup(file, "service", nameOrPath) as GenService<T>)
    : serviceDescByIndex(file, nameOrPath, ...paths);
}

export function extDesc<Extendee extends Message, Value>(
  file: DescFile,
  nameOrPath: string | number,
  ...paths: number[]
): GenExtension<Extendee, Value> {
  return typeof nameOrPath === "string"
    ? (lookup(file, "extension", nameOrPath) as GenExtension<Extendee, Value>)
    : extDescByIndex(file, nameOrPath, ...paths);
}
