import { clearField, create, isFieldSet } from "@bufbuild/protobuf";
import {
  type DescriptorProto,
  FieldDescriptorProtoSchema,
  type FileDescriptorProto,
  OneofDescriptorProtoSchema,
} from "@bufbuild/protobuf/wkt";

/**
 * What the descriptor would otherwise say by position. `T` is how an import
 * is referred to: the imported file object at runtime, its identifier when
 * the generated code is read without evaluating it.
 */
export type NameEntry<T> =
  | readonly ["oneof", string, string]
  | readonly ["public" | "weak", T];

/**
 * Put back what the embedder removed: `oneof_index` of real oneof members,
 * `public_dependency` / `weak_dependency`, and the synthetic oneofs.
 */
export function restoreNames<T>(
  file: FileDescriptorProto,
  names: readonly NameEntry<T>[],
  imports: readonly T[],
): void {
  const messages = new Map<string, DescriptorProto>();
  const collect = (list: DescriptorProto[], prefix: string) => {
    for (const message of list) {
      const name = `${prefix}${message.name}`;
      messages.set(name, message);
      collect(message.nestedType, `${name}.`);
    }
  };
  collect(file.messageType, "");
  for (const entry of names) {
    if (entry[0] === "oneof") {
      const [, member, oneofName] = entry;
      const cut = member.lastIndexOf(".");
      const message = messages.get(member.slice(0, cut));
      const field = message?.field.find(
        (f) => f.name === member.slice(cut + 1),
      );
      const index =
        message?.oneofDecl.findIndex((o) => o.name === oneofName) ?? -1;
      if (field === undefined || index < 0) {
        throw new Error(`unresolved oneof member ${member} -> ${oneofName}`);
      }
      field.oneofIndex = index;
    } else {
      const index = imports.indexOf(entry[1]);
      if (index < 0) {
        throw new Error(`unresolved ${entry[0]} import ${String(entry[1])}`);
      }
      (entry[0] === "public"
        ? file.publicDependency
        : file.weakDependency
      ).push(index);
    }
  }
  file.publicDependency.sort((a, b) => a - b);
  file.weakDependency.sort((a, b) => a - b);
  file.messageType.forEach(restoreSyntheticOneofs);
}

/**
 * Re-create the oneofs that protoc synthesizes for proto3 `optional`
 * fields, the way protoc names them: after the real oneofs, in field order,
 * `_` + field name, prefixed with `X` while that collides.
 */
export function restoreSyntheticOneofs(message: DescriptorProto): void {
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

/** Drop the synthetic oneofs that {@link restoreNames} re-creates. */
export function stripSyntheticOneofs(message: DescriptorProto): void {
  const synthetic = new Set(
    message.field.filter((f) => f.proto3Optional).map((f) => f.oneofIndex),
  );
  const real = message.oneofDecl.length - synthetic.size;
  // protoc appends synthetic oneofs after every real one.
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
 * Move what the descriptor says by position into name entries: real oneof
 * members and public / weak imports. Mutates `file`.
 */
export function extractNames<T>(
  file: FileDescriptorProto,
  imports: readonly T[],
): NameEntry<T>[] {
  file.messageType.forEach(stripSyntheticOneofs);
  const names: NameEntry<T>[] = [];
  const walk = (list: DescriptorProto[], prefix: string) => {
    for (const message of list) {
      const name = `${prefix}${message.name}`;
      for (const field of message.field) {
        // An unset oneof_index reads as 0, so check presence.
        if (isFieldSet(field, FieldDescriptorProtoSchema.field.oneofIndex)) {
          const oneof = message.oneofDecl[field.oneofIndex];
          names.push(["oneof", `${name}.${field.name}`, oneof.name]);
          clearField(field, FieldDescriptorProtoSchema.field.oneofIndex);
        }
      }
      walk(message.nestedType, `${name}.`);
    }
  };
  walk(file.messageType, "");
  for (const i of file.publicDependency) {
    names.push(["public", imports[i]]);
  }
  for (const i of file.weakDependency) {
    names.push(["weak", imports[i]]);
  }
  file.publicDependency = [];
  file.weakDependency = [];
  return names;
}
