import {
  clearField,
  create,
  isFieldSet,
  type Message,
} from "@bufbuild/protobuf";
import { BinaryReader, BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import {
  type DescriptorProto,
  FieldDescriptorProtoSchema,
  type FileDescriptorProto,
  OneofDescriptorProtoSchema,
} from "@bufbuild/protobuf/wkt";

// Markers that say by name what the descriptor would otherwise say by
// position. They are unknown fields with the largest field numbers;
// FieldDescriptorProto and FileDescriptorProto declare no extension ranges,
// so these numbers never carry real data.
/** On a field: the name of its real oneof, instead of `oneof_index`. */
const ONEOF = 536870911;
/** On the file: a public import's file name, instead of `public_dependency`. */
const PUBLIC_DEPENDENCY = 536870910;
/** On the file: a weak import's file name, instead of `weak_dependency`. */
const WEAK_DEPENDENCY = 536870909;

/**
 * Replace what the descriptor says by position with markers that say it by
 * name: real oneof members and public / weak imports. `dependency` lists the
 * imported file names, which the embedded descriptor leaves out. Synthetic
 * oneofs are dropped, since {@link restoreNames} re-creates them. Mutates
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

/** Remove the markers numbered `no` from `message` and return their values. */
function takeMarkers(message: Message, no: number): string[] {
  const values: string[] = [];
  const rest = (message.$unknown ?? []).filter((u) => {
    if (u.no !== no || u.wireType !== WireType.LengthDelimited) {
      return true;
    }
    values.push(new BinaryReader(u.data).string());
    return false;
  });
  if (values.length > 0) {
    if (rest.length > 0) {
      message.$unknown = rest;
    } else {
      delete message.$unknown;
    }
  }
  return values;
}

function stripSyntheticOneofs(message: DescriptorProto): void {
  const synthetic = new Set(
    message.field.filter((f) => f.proto3Optional).map((f) => f.oneofIndex),
  );
  const real = message.oneofDecl.length - synthetic.size;
  // protoc appends synthetic oneofs after every real one, which is what
  // restoreSyntheticOneofs relies on.
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

/**
 * Turn the markers of {@link embedNames} back into `oneof_index`,
 * `public_dependency` and `weak_dependency`, and re-create the synthetic
 * oneofs. `file.dependency` must already be set. Throws if a marker does not
 * resolve, e.g. after a bad merge.
 */
export function restoreNames(file: FileDescriptorProto): void {
  const imports = [
    [PUBLIC_DEPENDENCY, file.publicDependency, "public"],
    [WEAK_DEPENDENCY, file.weakDependency, "weak"],
  ] as const;
  for (const [no, indices, kind] of imports) {
    for (const name of takeMarkers(file, no)) {
      const index = file.dependency.indexOf(name);
      if (index < 0) {
        throw new Error(`${file.name}: unresolved ${kind} import ${name}`);
      }
      indices.push(index);
    }
  }
  const walk = (list: DescriptorProto[], prefix: string) => {
    for (const message of list) {
      const name = `${prefix}${message.name}`;
      for (const field of message.field) {
        const oneofs = takeMarkers(field, ONEOF);
        if (oneofs.length > 1) {
          throw new Error(`${name}.${field.name} is in several oneofs`);
        }
        if (oneofs.length === 1) {
          const index = message.oneofDecl.findIndex(
            (o) => o.name === oneofs[0],
          );
          if (index < 0) {
            throw new Error(
              `unresolved oneof member ${name}.${field.name} -> ${oneofs[0]}`,
            );
          }
          field.oneofIndex = index;
        }
      }
      walk(message.nestedType, `${name}.`);
    }
  };
  walk(file.messageType, "");
  file.messageType.forEach(restoreSyntheticOneofs);
}

/**
 * Re-create the oneofs that protoc synthesizes for proto3 `optional`
 * fields, the way protoc names them: after the real oneofs, in field order,
 * `_` + field name, prefixed with `X` while that collides.
 */
function restoreSyntheticOneofs(message: DescriptorProto): void {
  const taken = new Set([
    ...message.field.map((f) => f.name),
    ...message.oneofDecl.map((o) => o.name),
  ]);
  for (const field of message.field) {
    if (!field.proto3Optional) {
      continue;
    }
    let name = field.name.startsWith("_") ? field.name : `_${field.name}`;
    while (taken.has(name)) {
      name = `X${name}`;
    }
    taken.add(name);
    field.oneofIndex = message.oneofDecl.length;
    message.oneofDecl.push(create(OneofDescriptorProtoSchema, { name }));
  }
  message.nestedType.forEach(restoreSyntheticOneofs);
}
