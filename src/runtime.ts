import {
  createFileRegistry,
  type DescEnum,
  type DescExtension,
  type DescFile,
  type DescMessage,
  type DescService,
  fromBinary,
  isFieldSet,
  type JsonValue,
  type Message,
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
  serviceDesc as serviceDescByPath,
} from "@bufbuild/protobuf/codegenv2";
import { nestedTypes, protoCamelCase } from "@bufbuild/protobuf/reflect";
import {
  type DescriptorProto,
  FieldDescriptorProtoSchema,
  type FileDescriptorProto,
  FileDescriptorProtoSchema,
} from "@bufbuild/protobuf/wkt";
import { jsStringToBytes } from "./escape.js";
import { type NameEntry, restoreNames } from "./names.js";
import { type DescTree, fromTree } from "./tree.js";

export type { DescTree, NameEntry };

/**
 * Hydrate a file descriptor, like `fileDesc` from
 * `@bufbuild/protobuf/codegenv2`.
 *
 * - `desc` is a {@link DescTree}, or the raw byte string that earlier
 *   versions of this plugin emitted.
 * - `imports` are the files this file imports, in import order.
 * - `names` refers by name to what the descriptor would otherwise say by
 *   position: members of real oneofs, and public / weak imports. Synthetic
 *   oneofs of proto3 `optional` fields are re-created. Only used with a
 *   {@link DescTree}.
 */
export function fileDesc(
  desc: string | DescTree,
  imports: DescFile[] = [],
  names: readonly NameEntry<DescFile>[] = [],
): DescFile {
  if (typeof desc === "string") {
    return hydrate(
      fromBinary(FileDescriptorProtoSchema, jsStringToBytes(desc)),
      imports,
    );
  }
  const file = fromBinary(FileDescriptorProtoSchema, fromTree(desc));
  restoreNames(file, names, imports);
  return hydrate(file, imports);
}

/**
 * What `fileDesc` from `@bufbuild/protobuf/codegenv2` does after decoding
 * base64, without encoding the bytes to base64 first.
 */
function hydrate(root: FileDescriptorProto, imports: DescFile[]): DescFile {
  root.messageType.forEach(restoreJsonNames);
  root.dependency = imports.map((f) => f.proto.name);
  const registry = createFileRegistry(root, (name) =>
    imports.find((f) => f.proto.name === name),
  );
  return registry.getFile(root.name)!;
}

function restoreJsonNames(message: DescriptorProto): void {
  for (const field of message.field) {
    if (!isFieldSet(field, FieldDescriptorProtoSchema.field.jsonName)) {
      field.jsonName = protoCamelCase(field.name);
    }
  }
  message.nestedType.forEach(restoreJsonNames);
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
