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
  FileDescriptorProtoSchema,
} from "@bufbuild/protobuf/wkt";

/**
 * What `fileDesc` from `@bufbuild/protobuf/codegenv2` does after decoding
 * base64. The `*-direct` runtimes call this to skip the base64 round trip
 * that a native upstream implementation would not have.
 */
export function hydrate(bytes: Uint8Array, imports?: DescFile[]): DescFile {
  const root = fromBinary(FileDescriptorProtoSchema, bytes);
  root.messageType.forEach(restoreJsonNames);
  root.dependency = imports?.map((f) => f.proto.name) ?? [];
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
