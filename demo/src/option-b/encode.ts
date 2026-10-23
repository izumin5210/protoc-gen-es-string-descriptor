import type { DescMessage } from "@bufbuild/protobuf";
import { BinaryReader, WireType } from "@bufbuild/protobuf/wire";
import { FileDescriptorProtoSchema } from "@bufbuild/protobuf/wkt";
import { escapeBytesAsJSString } from "../../../src/escape.js";

/**
 * Wire format with the length prefix of every known sub-message removed.
 * Raw chunks are copied verbatim; nodes are re-prefixed at runtime.
 */
export type TreeItem = Uint8Array | TreeNode;

export interface TreeNode {
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
  // Each LEN field starts a new chunk and the scalars that follow it are
  // appended, so a field descriptor such as `name, number, label, type`
  // stays on a single line.
  let chunk: Uint8Array | undefined;
  const flush = () => {
    if (chunk !== undefined) {
      items.push(chunk);
      chunk = undefined;
    }
  };
  while (reader.pos < reader.len) {
    const start = reader.pos;
    const [fieldNo, wireType] = reader.tag();
    const tagEnd = reader.pos;
    if (wireType === WireType.LengthDelimited) {
      const length = reader.uint32();
      const bodyStart = reader.pos;
      reader.pos += length;
      const field = schema.fields.find((f) => f.number === fieldNo);
      const message =
        field?.fieldKind === "message"
          ? field.message
          : field?.fieldKind === "list" && field.listKind === "message"
            ? field.message
            : undefined;
      flush();
      if (message !== undefined) {
        items.push({
          tag: bytes.subarray(start, tagEnd),
          children: toTree(bytes.subarray(bodyStart, reader.pos), message),
        });
      } else {
        chunk = bytes.subarray(start, reader.pos);
      }
    } else {
      reader.skip(wireType, fieldNo);
      const raw = bytes.subarray(start, reader.pos);
      chunk = chunk === undefined ? raw : concat(chunk, raw);
    }
  }
  flush();
  return items;
}

/**
 * Render a tree as a JS array literal: one space of indentation per level and
 * a trailing comma on every element, so that appending an element never
 * touches the line before it.
 */
export function renderTree(items: TreeItem[], depth = 1): string {
  return items.map((item) => renderItem(item, depth)).join("\n");
}

function renderItem(item: TreeItem, depth: number): string {
  const pad = " ".repeat(depth);
  if (item instanceof Uint8Array) {
    return `${pad}${quote(item)},`;
  }
  const head = `${pad}[${quote(item.tag)}, [`;
  if (item.children.length === 0) {
    return `${head}]],`;
  }
  const [only] = item.children;
  if (item.children.length === 1 && only instanceof Uint8Array) {
    return `${head}${quote(only)}]],`;
  }
  return `${head}\n${renderTree(item.children, depth + 1)}\n${pad}]],`;
}

function quote(bytes: Uint8Array): string {
  return `"${escapeBytesAsJSString(bytes)}"`;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
