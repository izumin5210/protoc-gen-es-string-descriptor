import {
  createFileRegistry,
  type DescFile,
  fromBinary,
  isFieldSet,
} from "@bufbuild/protobuf";
import { protoCamelCase } from "@bufbuild/protobuf/reflect";
import {
  type DescriptorProto,
  FieldDescriptorProtoSchema,
  type FileDescriptorProto,
  FileDescriptorProtoSchema,
} from "@bufbuild/protobuf/wkt";

/**
 * What `fileDesc` from `@bufbuild/protobuf/codegenv2` does after decoding
 * base64. The `*-direct` runtimes call this to skip the base64 round trip
 * that a native upstream implementation would not have.
 */
export function hydrate(bytes: Uint8Array, imports?: DescFile[]): DescFile {
  return hydrateProto(fromBinary(FileDescriptorProtoSchema, bytes), imports);
}

/**
 * {@link hydrate} for a parsed descriptor. `restore` runs once `dependency`
 * is set, as the names runtime needs it to resolve import markers.
 */
export function hydrateProto(
  root: FileDescriptorProto,
  imports?: DescFile[],
  restore?: (root: FileDescriptorProto) => void,
): DescFile {
  root.messageType.forEach(restoreJsonNames);
  root.dependency = imports?.map((f) => f.proto.name) ?? [];
  restore?.(root);
  const registry = createFileRegistry(root, (name) =>
    imports?.find((f) => f.proto.name === name),
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
