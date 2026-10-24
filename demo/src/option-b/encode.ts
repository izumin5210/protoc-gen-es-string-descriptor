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

export interface TreeOptions {
  /**
   * Put every length-delimited unknown field on a line of its own, as the
   * names encoding does for its markers (see `../names/inline.ts`), so that
   * a marker's line does not depend on the scalars before it.
   */
  unknownOnOwnLine?: boolean;
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
  { unknownOnOwnLine = false }: TreeOptions = {},
): TreeItem[] {
  const items: TreeItem[] = [];
  const reader = new BinaryReader(bytes);
  // Every known string, bytes or packed field gets a chunk of its own, and
  // consecutive scalars and unknown fields share one, so that a field
  // descriptor's name and its number, label and type are on separate lines.
  let run: Uint8Array | undefined;
  const flush = () => {
    if (run !== undefined) {
      items.push(run);
      run = undefined;
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
        field.fieldKind === "message"
          ? field.message
          : field.fieldKind === "list" && field.listKind === "message"
            ? field.message
            : undefined;
      flush();
      items.push(
        message === undefined
          ? bytes.subarray(start, reader.pos)
          : {
              tag: bytes.subarray(start, tagEnd),
              children: toTree(bytes.subarray(bodyStart, reader.pos), message, {
                unknownOnOwnLine,
              }),
            },
      );
    } else {
      reader.skip(wireType, fieldNo);
      const raw = bytes.subarray(start, reader.pos);
      if (unknownOnOwnLine && wireType === WireType.LengthDelimited) {
        flush();
        items.push(raw);
      } else {
        run = run === undefined ? raw : concat(run, raw);
      }
    }
  }
  flush();
  return items;
}

/**
 * Render a tree as a JS array literal: one element per line, one space of
 * indentation per level and a trailing comma on every element, so that
 * appending an element never touches the line before it.
 */
export function renderTree(items: TreeItem[], depth = 1): string {
  return items.map((item) => renderItem(item, depth)).join("\n");
}

function renderItem(item: TreeItem, depth: number): string {
  const pad = " ".repeat(depth);
  if (item instanceof Uint8Array) {
    return `${pad}${quote(item)},`;
  }
  return [
    `${pad}[${quote(item.tag)}, [`,
    ...(item.children.length === 0
      ? []
      : [renderTree(item.children, depth + 1)]),
    `${pad}]],`,
  ].join("\n");
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
