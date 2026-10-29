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
  enumDesc as enumDescByPath,
  extDesc as extDescByPath,
  type GenEnum,
  type GenExtension,
  type GenMessage,
  type GenService,
  type GenServiceMethods,
  messageDesc as messageDescByPath,
  fileDesc as originalFileDesc,
  serviceDesc as serviceDescByPath,
} from "@bufbuild/protobuf/codegenv2";
import { nestedTypes } from "@bufbuild/protobuf/reflect";
import { base64Encode } from "@bufbuild/protobuf/wire";
import { jsStringToBytes } from "./escape.js";
import { type DescTree, fromTree } from "./tree.js";

export type { DescTree };

/**
 * Hydrate a file descriptor with `fileDesc` from
 * `@bufbuild/protobuf/codegenv2`.
 *
 * - `desc` is a {@link DescTree}, or the raw byte string that earlier
 *   versions of this plugin emitted. In a {@link DescTree}, real oneof
 *   members and public / weak imports are marked by name, and synthetic
 *   oneofs of proto3 `optional` fields are left out; both are restored while
 *   the bytes are rebuilt, so that codegenv2 gets exactly the bytes that
 *   protoc-gen-es embeds.
 * - `imports` are the files this file imports, in import order.
 */
export function fileDesc(
  desc: string | DescTree,
  imports: DescFile[] = [],
): DescFile {
  const bytes =
    typeof desc === "string"
      ? jsStringToBytes(desc)
      : fromTree(
          desc,
          imports.map((f) => f.proto.name),
        );
  return originalFileDesc(base64Encode(bytes, "std_raw"), imports);
}

type AnyDesc = DescMessage | DescEnum | DescService | DescExtension;

const elementsByFile = new WeakMap<DescFile, Map<string, AnyDesc>>();

/**
 * Look an element up by its name relative to the package, e.g.
 * "Outer.Inner", in a map built on first use per file.
 */
function lookup<K extends AnyDesc["kind"]>(
  file: DescFile,
  kind: K,
  name: string,
): Extract<AnyDesc, { kind: K }> {
  let elements = elementsByFile.get(file);
  if (elements === undefined) {
    const prefix =
      file.proto.package === "" ? 0 : file.proto.package.length + 1;
    elements = new Map();
    for (const desc of nestedTypes(file)) {
      elements.set(desc.typeName.slice(prefix), desc);
    }
    elementsByFile.set(file, elements);
  }
  const desc = elements.get(name);
  if (desc?.kind !== kind) {
    throw new Error(`${kind} ${name} not found in ${file.proto.name}`);
  }
  return desc as Extract<AnyDesc, { kind: K }>;
}

/**
 * Hydrate a message descriptor by its name relative to the package, or by
 * the path that `messageDesc` from `@bufbuild/protobuf/codegenv2` takes.
 */
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
    : messageDescByPath(file, nameOrPath, ...paths);
}

/** Like {@link messageDesc}, for enums. */
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
    : enumDescByPath(file, nameOrPath, ...paths);
}

/** Like {@link messageDesc}, for services. */
export function serviceDesc<T extends GenServiceMethods>(
  file: DescFile,
  nameOrPath: string | number,
  ...paths: number[]
): GenService<T> {
  return typeof nameOrPath === "string"
    ? (lookup(file, "service", nameOrPath) as GenService<T>)
    : serviceDescByPath(file, nameOrPath, ...paths);
}

/** Like {@link messageDesc}, for extensions. */
export function extDesc<Extendee extends Message, Value>(
  file: DescFile,
  nameOrPath: string | number,
  ...paths: number[]
): GenExtension<Extendee, Value> {
  return typeof nameOrPath === "string"
    ? (lookup(file, "extension", nameOrPath) as GenExtension<Extendee, Value>)
    : extDescByPath(file, nameOrPath, ...paths);
}
