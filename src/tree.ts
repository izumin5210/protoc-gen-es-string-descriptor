import type { DescMessage } from "@bufbuild/protobuf";
import { BinaryReader, BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import { FileDescriptorProtoSchema } from "@bufbuild/protobuf/wkt";
import { escapeBytesAsJSString, jsStringToBytes } from "./escape.js";

/**
 * A serialized message without length prefixes, as generated code passes it
 * to `fileDesc`. Each string is raw wire bytes (one char per byte). Each pair
 * is the tag of a sub-message field followed by the sub-message.
 */
export type DescTree = ReadonlyArray<string | readonly [string, DescTree]>;

/** Serialize a {@link DescTree}, recomputing the length prefixes. */
export function fromTree(tree: DescTree): Uint8Array {
  const writer = new BinaryWriter();
  writeTree(writer, tree);
  return writer.finish();
}

function writeTree(writer: BinaryWriter, tree: DescTree): void {
  for (const item of tree) {
    if (typeof item === "string") {
      writer.raw(jsStringToBytes(item));
    } else {
      writer.raw(jsStringToBytes(item[0])).fork();
      writeTree(writer, item[1]);
      writer.join();
    }
  }
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
  // Every known string or bytes field gets a chunk of its own, and
  // consecutive scalars and unknown fields share one, so that a field
  // descriptor's name and its number, label and type are on separate lines.
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
      run.push(bytes.subarray(start, reader.pos));
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
