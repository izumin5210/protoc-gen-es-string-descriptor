import { clearField, isFieldSet, type Message } from "@bufbuild/protobuf";
import { BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import {
  type DescriptorProto,
  FieldDescriptorProtoSchema,
  type FileDescriptorProto,
} from "@bufbuild/protobuf/wkt";

import { ONEOF, PUBLIC_DEPENDENCY, WEAK_DEPENDENCY } from "./markers.js";

/**
 * Replace what the descriptor says by position with markers that say it by
 * name: real oneof members and public / weak imports. `dependency` lists the
 * imported file names, which the embedded descriptor leaves out. Synthetic
 * oneofs are dropped, since `fromTree` re-creates them. Mutates
 * `file`.
 */
export function embedNames(
  file: FileDescriptorProto,
  dependency: readonly string[],
): void {
  file.messageType.forEach(stripSyntheticOneofs);
  const walk = (list: DescriptorProto[]) => {
    for (const message of list) {
      for (const field of message.field) {
        // An unset oneof_index reads as 0, so check presence.
        if (isFieldSet(field, FieldDescriptorProtoSchema.field.oneofIndex)) {
          addMarker(field, ONEOF, message.oneofDecl[field.oneofIndex].name);
          clearField(field, FieldDescriptorProtoSchema.field.oneofIndex);
        }
      }
      walk(message.nestedType);
    }
  };
  walk(file.messageType);
  const imports = [
    [PUBLIC_DEPENDENCY, file.publicDependency],
    [WEAK_DEPENDENCY, file.weakDependency],
  ] as const;
  for (const [no, indices] of imports) {
    for (const i of indices) {
      if (dependency[i] === undefined) {
        throw new Error(`${file.name}: no file name for import ${i}`);
      }
      addMarker(file, no, dependency[i]);
    }
  }
  file.publicDependency = [];
  file.weakDependency = [];
}

function addMarker(message: Message, no: number, value: string): void {
  message.$unknown = [
    ...(message.$unknown ?? []),
    {
      no,
      wireType: WireType.LengthDelimited,
      // The payload with its length prefix, but without the tag.
      data: new BinaryWriter().string(value).finish(),
    },
  ];
}

function stripSyntheticOneofs(message: DescriptorProto): void {
  const synthetic = new Set(
    message.field.filter((f) => f.proto3Optional).map((f) => f.oneofIndex),
  );
  const real = message.oneofDecl.length - synthetic.size;
  // protoc appends synthetic oneofs after every real one, which is what
  // fromTree relies on.
  if ([...synthetic].some((i) => i < real)) {
    throw new Error(`synthetic oneof before a real one in ${message.name}`);
  }
  message.oneofDecl = message.oneofDecl.slice(0, real);
  for (const field of message.field) {
    if (field.proto3Optional) {
      clearField(field, FieldDescriptorProtoSchema.field.oneofIndex);
    }
  }
  message.nestedType.forEach(stripSyntheticOneofs);
}
