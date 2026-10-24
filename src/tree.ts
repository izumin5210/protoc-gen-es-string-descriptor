import type { DescMessage } from "@bufbuild/protobuf";
import { BinaryReader, WireType } from "@bufbuild/protobuf/wire";
import { FileDescriptorProtoSchema } from "@bufbuild/protobuf/wkt";
import { escapeBytesAsJSString, jsStringToBytes } from "./escape.js";
import { ONEOF, PUBLIC_DEPENDENCY, WEAK_DEPENDENCY } from "./markers.js";

/**
 * A serialized message without length prefixes, as generated code passes it
 * to `fileDesc`. Each string is raw wire bytes (one char per byte). Each pair
 * is the tag of a sub-message field followed by the sub-message.
 */
export type DescTree = ReadonlyArray<string | readonly [string, DescTree]>;

/**
 * Serialize a {@link DescTree} of a `FileDescriptorProto`, recomputing the
 * length prefixes, and restore what the plugin replaced or left out, in the
 * order that protobuf-es serializes it:
 *
 * - a field's oneof marker becomes `oneof_index` of the named real oneof;
 * - the synthetic oneofs of proto3 `optional` fields are re-created after the
 *   real ones, and the fields point at them;
 * - the file's import markers become `public_dependency` /
 *   `weak_dependency`, resolved against `dependency`, the file names of the
 *   imports in import order.
 *
 * Only files, messages and their fields are parsed; everything else is
 * copied as is. Throws if a marker does not resolve, e.g. after a bad merge.
 */
export function fromTree(
  tree: DescTree,
  dependency: readonly string[] = [],
): Uint8Array {
  return serialize(restoreFile(tree, dependency.map(utf8)));
}

// Field numbers in descriptor.proto.
const FILE_MESSAGE_TYPE = 4;
const FILE_PUBLIC_DEPENDENCY = 10;
const FILE_WEAK_DEPENDENCY = 11;
const MESSAGE_NAME = 1;
const MESSAGE_FIELD = 2;
const MESSAGE_NESTED_TYPE = 3;
const MESSAGE_ONEOF_DECL = 8;
const FIELD_NAME = 1;
const FIELD_ONEOF_INDEX = 9;
const FIELD_PROTO3_OPTIONAL = 17;
const ONEOF_NAME = 1;
const FIELD_MARKERS = [ONEOF];

type Item = DescTree[number];

/**
 * What a scan of the items of a message found: one length-delimited field,
 * one varint, the markers to drop, and where to insert the restored fields.
 * Strings in a tree are raw bytes, one char per byte, so names are compared
 * as UTF-8 bytes without decoding.
 */
interface Scan {
  string?: string;
  varint: number;
  /** Markers as [item, start, end, field number, payload]. */
  markers: [number, number, number, number, string][];
  /** Item and offset of the first field numbered above `after`. */
  insertAt: [number, number];
}

const NO_MARKERS: readonly number[] = [];

/**
 * Scan the fields of `items` without copying them: read the field numbered
 * `stringNo` and the varint numbered `varintNo`, and find the unknown fields
 * numbered in `markerNos`.
 */
function scan(
  items: DescTree,
  after: number,
  stringNo = 0,
  varintNo = 0,
  markerNos = NO_MARKERS,
): Scan {
  const result: Scan = { varint: 0, markers: [], insertAt: [items.length, 0] };
  let found = false;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (typeof item !== "string") {
      if (!found && fieldNo(item[0]) > after) {
        result.insertAt = [i, 0];
        found = true;
      }
      continue;
    }
    let pos = 0;
    while (pos < item.length) {
      const start = pos;
      const tag = readVarint(item, pos);
      const no = Math.floor(tag / 8);
      const wireType = tag % 8;
      pos = varintEnd;
      switch (wireType) {
        case WireType.Varint: {
          const value = readVarint(item, pos);
          pos = varintEnd;
          if (no === varintNo) {
            result.varint = value;
          }
          break;
        }
        case WireType.Bit64:
          pos += 8;
          break;
        case WireType.LengthDelimited: {
          const length = readVarint(item, pos);
          const payloadStart = varintEnd;
          pos = payloadStart + length;
          if (markerNos.includes(no)) {
            result.markers.push([
              i,
              start,
              pos,
              no,
              item.slice(payloadStart, pos),
            ]);
            continue;
          }
          if (no === stringNo) {
            result.string = item.slice(payloadStart, pos);
          }
          break;
        }
        case WireType.Bit32:
          pos += 4;
          break;
        default:
          throw new Error(`unexpected wire type ${wireType}`);
      }
      if (!found && no > after) {
        result.insertAt = [i, start];
        found = true;
      }
    }
  }
  return result;
}

/**
 * `items` without the markers of `scan`, with `insert` at its insertion
 * point and with `replace` applied to sub-messages.
 */
function rewrite(
  items: DescTree,
  { markers, insertAt }: Scan,
  insert: Item[],
  replace: (item: readonly [string, DescTree], index: number) => Item = (
    item,
  ) => item,
): Item[] {
  const out: Item[] = [];
  for (let i = 0; i <= items.length; i++) {
    const item = items[i];
    if (typeof item !== "string") {
      if (i === insertAt[0]) {
        out.push(...insert);
      }
      if (item !== undefined) {
        out.push(replace(item, i));
      }
      continue;
    }
    // Cut the markers out of the string, and split it at the insertion point.
    const cuts: [number, number][] = markers
      .filter(([m]) => m === i)
      .map(([, start, end]) => [start, end]);
    if (i === insertAt[0]) {
      cuts.push([insertAt[1], insertAt[1]]);
      cuts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    }
    if (cuts.length === 0) {
      out.push(item);
      continue;
    }
    let pos = 0;
    for (const [start, end] of cuts) {
      if (start > pos) {
        out.push(item.slice(pos, start));
      }
      if (start === end && i === insertAt[0] && start === insertAt[1]) {
        out.push(...insert);
      }
      pos = Math.max(pos, end);
    }
    if (pos < item.length) {
      out.push(item.slice(pos));
    }
  }
  return out;
}

function restoreFile(tree: DescTree, dependency: string[]): DescTree {
  const found = scan(tree, FILE_WEAK_DEPENDENCY, 0, 0, [
    PUBLIC_DEPENDENCY,
    WEAK_DEPENDENCY,
  ]);
  const publicDeps: string[] = [];
  const weakDeps: string[] = [];
  for (const [, , , no, name] of found.markers) {
    const index = dependency.indexOf(name);
    const kind = no === PUBLIC_DEPENDENCY ? "public" : "weak";
    if (index < 0) {
      throw new Error(`unresolved ${kind} import ${fromUtf8(name)}`);
    }
    (no === PUBLIC_DEPENDENCY ? publicDeps : weakDeps).push(
      varintField(
        no === PUBLIC_DEPENDENCY
          ? FILE_PUBLIC_DEPENDENCY
          : FILE_WEAK_DEPENDENCY,
        index,
      ),
    );
  }
  return rewrite(tree, found, [...publicDeps, ...weakDeps], (item) =>
    fieldNo(item[0]) === FILE_MESSAGE_TYPE
      ? [item[0], restoreMessage(item[1])]
      : item,
  );
}

function restoreMessage(items: DescTree): DescTree {
  const message = scan(items, MESSAGE_ONEOF_DECL, MESSAGE_NAME);
  const oneofs: string[] = [];
  const fields: { index: number; scan: Scan }[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (typeof item === "string") {
      continue;
    }
    const no = fieldNo(item[0]);
    if (no === MESSAGE_ONEOF_DECL) {
      oneofs.push(scan(item[1], Infinity, ONEOF_NAME).string ?? "");
    } else if (no === MESSAGE_FIELD) {
      fields.push({
        index: i,
        scan: scan(
          item[1],
          FIELD_ONEOF_INDEX,
          FIELD_NAME,
          FIELD_PROTO3_OPTIONAL,
          FIELD_MARKERS,
        ),
      });
    }
  }
  const fieldName = (f: Scan) => f.string ?? "";
  const memberName = (f: Scan) =>
    `${fromUtf8(message.string ?? "")}.${fromUtf8(fieldName(f))}`;
  // protoc names synthetic oneofs `_` + field name, prefixed with `X` while
  // that collides, and appends them after the real ones in field order.
  const taken = new Set([...fields.map((f) => fieldName(f.scan)), ...oneofs]);
  const synthetic: Item[] = [];
  const restored = new Map<number, DescTree>();
  for (const { index, scan: field } of fields) {
    let oneofIndex: number | undefined;
    if (field.markers.length > 1) {
      throw new Error(`${memberName(field)} is in several oneofs`);
    }
    if (field.varint !== 0) {
      const base = fieldName(field);
      let name = base.startsWith("_") ? base : `_${base}`;
      while (taken.has(name)) {
        name = `X${name}`;
      }
      taken.add(name);
      oneofIndex = oneofs.length + synthetic.length;
      synthetic.push([
        tagString(MESSAGE_ONEOF_DECL, WireType.LengthDelimited),
        [lengthDelimitedField(ONEOF_NAME, name)],
      ]);
    } else if (field.markers.length === 1) {
      const oneof = field.markers[0][4];
      oneofIndex = oneofs.indexOf(oneof);
      if (oneofIndex < 0) {
        throw new Error(
          `unresolved oneof member ${memberName(field)} -> ${fromUtf8(oneof)}`,
        );
      }
    }
    if (oneofIndex !== undefined) {
      const item = items[index] as readonly [string, DescTree];
      restored.set(
        index,
        rewrite(item[1], field, [varintField(FIELD_ONEOF_INDEX, oneofIndex)]),
      );
    }
  }
  if (synthetic.length === 0 && restored.size === 0) {
    // Nested messages may still need restoring.
    if (!items.some((item) => isNestedMessage(item))) {
      return items;
    }
  }
  return rewrite(items, message, synthetic, (item, i) => {
    const fieldItems = restored.get(i);
    if (fieldItems !== undefined) {
      return [item[0], fieldItems];
    }
    return isNestedMessage(item) ? [item[0], restoreMessage(item[1])] : item;
  });
}

function isNestedMessage(item: Item): item is readonly [string, DescTree] {
  return typeof item !== "string" && fieldNo(item[0]) === MESSAGE_NESTED_TYPE;
}

/**
 * Serialize in two passes, so that the output is a single allocation: first
 * the body size of every sub-message in pre-order, then the bytes.
 */
function serialize(tree: DescTree): Uint8Array {
  const bodySizes: number[] = [];
  const out = new Uint8Array(measure(tree, bodySizes));
  write(tree, out, 0, bodySizes, { next: 0 });
  return out;
}

function measure(tree: DescTree, bodySizes: number[]): number {
  let size = 0;
  for (const item of tree) {
    if (typeof item === "string") {
      size += item.length;
    } else {
      const index = bodySizes.push(0) - 1;
      const body = measure(item[1], bodySizes);
      bodySizes[index] = body;
      size += item[0].length + varintSize(body) + body;
    }
  }
  return size;
}

function write(
  tree: DescTree,
  out: Uint8Array,
  pos: number,
  bodySizes: number[],
  cursor: { next: number },
): number {
  for (const item of tree) {
    if (typeof item === "string") {
      pos = writeRaw(item, out, pos);
    } else {
      pos = writeRaw(item[0], out, pos);
      let body = bodySizes[cursor.next++];
      while (body > 0x7f) {
        out[pos++] = (body & 0x7f) | 0x80;
        body >>>= 7;
      }
      out[pos++] = body;
      pos = write(item[1], out, pos, bodySizes, cursor);
    }
  }
  return pos;
}

function writeRaw(raw: string, out: Uint8Array, pos: number): number {
  for (let i = 0; i < raw.length; i++) {
    out[pos++] = raw.charCodeAt(i);
  }
  return pos;
}

function varintSize(n: number): number {
  let size = 1;
  while (n > 0x7f) {
    n >>>= 7;
    size++;
  }
  return size;
}

/** Where the varint that {@link readVarint} read last ends. */
let varintEnd = 0;

/** A varint at `pos`, ending at {@link varintEnd}. Exact up to 2^53. */
function readVarint(s: string, pos: number): number {
  let value = 0;
  let scale = 1;
  let byte: number;
  do {
    byte = s.charCodeAt(pos++);
    value += (byte & 0x7f) * scale;
    scale *= 128;
  } while (byte & 0x80);
  varintEnd = pos;
  return value;
}

/** The field number of a tag. */
function fieldNo(tag: string): number {
  return Math.floor(readVarint(tag, 0) / 8);
}

/** A varint as raw bytes, for non-negative values below 2^31. */
function varintString(n: number): string {
  let s = "";
  while (n > 0x7f) {
    s += String.fromCharCode((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  return s + String.fromCharCode(n);
}

function tagString(no: number, wireType: WireType): string {
  return varintString((no << 3) | wireType);
}

function varintField(no: number, value: number): string {
  return tagString(no, WireType.Varint) + varintString(value);
}

function lengthDelimitedField(no: number, raw: string): string {
  return (
    tagString(no, WireType.LengthDelimited) + varintString(raw.length) + raw
  );
}

/** A string as raw UTF-8 bytes, one char per byte, as in a tree. */
function utf8(s: string): string {
  return latin1(new TextEncoder().encode(s));
}

function fromUtf8(raw: string): string {
  return new TextDecoder().decode(jsStringToBytes(raw));
}

/**
 * Wire format with the length prefix of every known sub-message removed.
 * Raw chunks are copied verbatim; nodes are re-prefixed at runtime.
 */
export type TreeItem = Uint8Array | TreeNode;

interface TreeNode {
  tag: Uint8Array;
  children: TreeItem[];
}

/**
 * Split serialized descriptor bytes into a length-less tree.
 *
 * Only LEN fields that the schema declares as messages become nodes.
 * Everything else, including unknown fields such as option extensions,
 * stays raw because its layout is not known without the extension schema.
 */
export function toTree(
  bytes: Uint8Array,
  schema: DescMessage = FileDescriptorProtoSchema,
): TreeItem[] {
  const items: TreeItem[] = [];
  const reader = new BinaryReader(bytes);
  // Every string, bytes or other length-delimited field gets a chunk of its
  // own, and consecutive scalars share one, so that a field descriptor's
  // name, its number, label and type, and a marker of its oneof (an unknown
  // field, see names.ts) are on separate lines.
  let run: Uint8Array[] = [];
  const flush = () => {
    if (run.length > 0) {
      items.push(concat(run));
      run = [];
    }
  };
  while (reader.pos < reader.len) {
    const start = reader.pos;
    const [fieldNo, wireType] = reader.tag();
    const tagEnd = reader.pos;
    const field = schema.fields.find((f) => f.number === fieldNo);
    if (field !== undefined && wireType === WireType.LengthDelimited) {
      const length = reader.uint32();
      const bodyStart = reader.pos;
      reader.pos += length;
      const message =
        field.fieldKind === "message" ||
        (field.fieldKind === "list" && field.listKind === "message")
          ? field.message
          : undefined;
      flush();
      items.push(
        message === undefined
          ? bytes.subarray(start, reader.pos)
          : {
              tag: bytes.subarray(start, tagEnd),
              children: toTree(bytes.subarray(bodyStart, reader.pos), message),
            },
      );
    } else {
      reader.skip(wireType, fieldNo);
      if (wireType === WireType.LengthDelimited) {
        flush();
        items.push(bytes.subarray(start, reader.pos));
      } else {
        run.push(bytes.subarray(start, reader.pos));
      }
    }
  }
  flush();
  return items;
}

/**
 * Render a tree as the body of a JS array literal: one element per line, one
 * space of indentation per level and a trailing comma on every element, so
 * that appending an element never touches the line before it.
 */
export function renderTree(items: TreeItem[], depth = 1): string[] {
  const pad = " ".repeat(depth);
  return items.flatMap((item) =>
    item instanceof Uint8Array
      ? [`${pad}${quote(item)},`]
      : [
          `${pad}[${quote(item.tag)}, [`,
          ...renderTree(item.children, depth + 1),
          `${pad}]],`,
        ],
  );
}

/** The {@link DescTree} that the output of {@link renderTree} evaluates to. */
export function evaluateTree(items: TreeItem[]): DescTree {
  return items.map((item) =>
    item instanceof Uint8Array
      ? latin1(item)
      : [latin1(item.tag), evaluateTree(item.children)],
  );
}

function latin1(bytes: Uint8Array): string {
  let s = "";
  for (const byte of bytes) {
    s += String.fromCharCode(byte);
  }
  return s;
}

function quote(bytes: Uint8Array): string {
  return `"${escapeBytesAsJSString(bytes)}"`;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) {
    return chunks[0];
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
}
