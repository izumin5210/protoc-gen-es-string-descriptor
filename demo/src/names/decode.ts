import { BinaryReader, BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import { jsStringToBytes } from "../../../src/escape.js";
import type { DescTree } from "../option-b/runtime.js";
import { ONEOF, PUBLIC_DEPENDENCY, WEAK_DEPENDENCY } from "./inline.js";

// Field numbers that the decoder needs to know; everything else is copied
// without a schema.
const FILE_MESSAGE_TYPE = 4;
const FILE_PUBLIC_DEPENDENCY = 10;
const FILE_WEAK_DEPENDENCY = 11;
const MESSAGE_FIELD = 2;
const MESSAGE_NESTED_TYPE = 3;
const MESSAGE_ONEOF_DECL = 8;
const FIELD_NAME = 1;
const FIELD_ONEOF_INDEX = 9;
const FIELD_PROTO3_OPTIONAL = 17;
const ONEOF_NAME = 1;

/**
 * Serialize a nested array of the names encoding into the bytes that
 * protoc-gen-es embeds, restoring at the byte level what the markers say by
 * name: `oneof_index` of real oneof members, the synthetic oneofs of proto3
 * `optional` fields, and `public_dependency` / `weak_dependency`, resolved
 * against `importNames`. Only `FileDescriptorProto`, `DescriptorProto`,
 * `FieldDescriptorProto` and `OneofDescriptorProto` are looked into.
 */
export function fromNamedTree(
  tree: DescTree,
  importNames: readonly string[],
): Uint8Array {
  const writer = new BinaryWriter();
  for (const item of tree) {
    if (typeof item === "string") {
      const bytes = jsStringToBytes(item);
      const marker = readMarker(bytes);
      if (marker?.no === PUBLIC_DEPENDENCY || marker?.no === WEAK_DEPENDENCY) {
        const index = importNames.indexOf(marker.value);
        if (index < 0) {
          throw new Error(`unresolved import ${marker.value}`);
        }
        writer
          .tag(
            marker.no === PUBLIC_DEPENDENCY
              ? FILE_PUBLIC_DEPENDENCY
              : FILE_WEAK_DEPENDENCY,
            WireType.Varint,
          )
          .int32(index);
      } else {
        writer.raw(bytes);
      }
    } else if (tagNumber(item[0]) === FILE_MESSAGE_TYPE) {
      writeNode(writer, item[0], () => writeMessage(writer, item[1], ""));
    } else {
      writeNode(writer, item[0], () => writeRaw(writer, item[1]));
    }
  }
  return writer.finish();
}

function writeMessage(
  writer: BinaryWriter,
  children: DescTree,
  scope: string,
): void {
  const fieldNames: string[] = [];
  const oneofNames: string[] = [];
  const optional: boolean[] = [];
  let name = "";
  for (const item of children) {
    if (typeof item === "string") {
      name = stringField(jsStringToBytes(item), FIELD_NAME) ?? name;
      continue;
    }
    const no = tagNumber(item[0]);
    if (no === MESSAGE_FIELD) {
      const strings = item[1].filter((c) => typeof c === "string");
      const bytes = strings.map((s) => jsStringToBytes(s));
      fieldNames.push(
        bytes.map((b) => stringField(b, FIELD_NAME)).find((n) => n) ?? "",
      );
      optional.push(bytes.some((b) => varintField(b, FIELD_PROTO3_OPTIONAL)));
    } else if (no === MESSAGE_ONEOF_DECL) {
      const strings = item[1].filter((c) => typeof c === "string");
      oneofNames.push(
        strings
          .map((s) => stringField(jsStringToBytes(s), ONEOF_NAME))
          .find((n) => n) ?? "",
      );
    }
  }
  // The synthetic oneofs, named the way protoc names them: after the real
  // oneofs, in field order, `_` + field name, prefixed with `X` while that
  // collides.
  const taken = new Set([...fieldNames, ...oneofNames]);
  const synthetic: string[] = [];
  const syntheticIndex = fieldNames.map((field, i) => {
    if (!optional[i]) {
      return undefined;
    }
    let oneof = field.startsWith("_") ? field : `_${field}`;
    while (taken.has(oneof)) {
      oneof = `X${oneof}`;
    }
    taken.add(oneof);
    synthetic.push(oneof);
    return oneofNames.length + synthetic.length - 1;
  });
  const path = `${scope}${name}`;
  let field = 0;
  for (const item of children) {
    if (typeof item === "string") {
      writer.raw(jsStringToBytes(item));
      continue;
    }
    const no = tagNumber(item[0]);
    if (no === MESSAGE_FIELD) {
      const index = syntheticIndex[field++];
      writeNode(writer, item[0], () =>
        writeField(writer, item[1], oneofNames, index, path),
      );
    } else if (no === MESSAGE_NESTED_TYPE) {
      writeNode(writer, item[0], () =>
        writeMessage(writer, item[1], `${path}.`),
      );
    } else {
      writeNode(writer, item[0], () => writeRaw(writer, item[1]));
    }
  }
  for (const oneof of synthetic) {
    writer.tag(MESSAGE_ONEOF_DECL, WireType.LengthDelimited).fork();
    writer.tag(ONEOF_NAME, WireType.LengthDelimited).string(oneof);
    writer.join();
  }
}

function writeField(
  writer: BinaryWriter,
  children: DescTree,
  oneofNames: string[],
  syntheticIndex: number | undefined,
  message: string,
): void {
  let oneofIndex = syntheticIndex;
  for (const item of children) {
    if (typeof item !== "string") {
      writeNode(writer, item[0], () => writeRaw(writer, item[1]));
      continue;
    }
    const bytes = jsStringToBytes(item);
    const marker = readMarker(bytes);
    if (marker?.no !== ONEOF) {
      writer.raw(bytes);
      continue;
    }
    if (oneofIndex !== undefined) {
      throw new Error(`a field of ${message} is in several oneofs`);
    }
    oneofIndex = oneofNames.indexOf(marker.value);
    if (oneofIndex < 0) {
      throw new Error(`unresolved oneof ${message}.${marker.value}`);
    }
  }
  if (oneofIndex !== undefined) {
    writer.tag(FIELD_ONEOF_INDEX, WireType.Varint).int32(oneofIndex);
  }
}

function writeRaw(writer: BinaryWriter, tree: DescTree): void {
  for (const item of tree) {
    if (typeof item === "string") {
      writer.raw(jsStringToBytes(item));
    } else {
      writeNode(writer, item[0], () => writeRaw(writer, item[1]));
    }
  }
}

function writeNode(writer: BinaryWriter, tag: string, body: () => void) {
  writer.raw(jsStringToBytes(tag)).fork();
  body();
  writer.join();
}

function tagNumber(tag: string): number {
  return new BinaryReader(jsStringToBytes(tag)).tag()[0];
}

/** A chunk that is exactly one marker: a length-delimited reserved field. */
function readMarker(
  bytes: Uint8Array,
): { no: number; value: string } | undefined {
  const reader = new BinaryReader(bytes);
  const [no, wireType] = reader.tag();
  if (
    wireType !== WireType.LengthDelimited ||
    (no !== ONEOF && no !== PUBLIC_DEPENDENCY && no !== WEAK_DEPENDENCY)
  ) {
    return undefined;
  }
  const value = reader.string();
  if (reader.pos !== reader.len) {
    throw new Error(`marker ${no} shares its line with another field`);
  }
  return { no, value };
}

/** The value of string field `no` in a chunk of fields, if present. */
function stringField(bytes: Uint8Array, no: number): string | undefined {
  const reader = new BinaryReader(bytes);
  while (reader.pos < reader.len) {
    const [n, wireType] = reader.tag();
    if (n === no && wireType === WireType.LengthDelimited) {
      return reader.string();
    }
    reader.skip(wireType, n);
  }
  return undefined;
}

/** Whether varint field `no` is set to a non-zero value in a chunk. */
function varintField(bytes: Uint8Array, no: number): boolean {
  const reader = new BinaryReader(bytes);
  let set = false;
  while (reader.pos < reader.len) {
    const [n, wireType] = reader.tag();
    if (n === no && wireType === WireType.Varint) {
      set = reader.uint32() !== 0;
    } else {
      reader.skip(wireType, n);
    }
  }
  return set;
}
