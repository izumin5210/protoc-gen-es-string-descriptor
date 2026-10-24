import { type DescTree, fromTree } from "../option-b/runtime.js";

// Tags as one char per byte, the way a DescTree holds them. Only these are
// looked at; everything else is copied without a schema.
const MESSAGE_TYPE = '"'; // FileDescriptorProto.message_type = 4, LEN
const PUBLIC_DEPENDENCY = "P"; // FileDescriptorProto.public_dependency = 10
const WEAK_DEPENDENCY = "X"; // FileDescriptorProto.weak_dependency = 11
const NAME = "\n"; // `name = 1` of DescriptorProto, FieldDescriptorProto, OneofDescriptorProto
const FIELD = "\x12"; // DescriptorProto.field = 2
const NESTED_TYPE = "\x1a"; // DescriptorProto.nested_type = 3
const ONEOF_DECL = "B"; // DescriptorProto.oneof_decl = 8
const ONEOF_INDEX = "H"; // FieldDescriptorProto.oneof_index = 9
const PROTO3_OPTIONAL = 17; // FieldDescriptorProto.proto3_optional
const PROTO3_OPTIONAL_TRUE = "\x88\x01\x01"; // a quick filter for it
// The markers of inline.ts: fields 536870911, 536870910 and 536870909, LEN.
const ONEOF_MARKER = "\xfa\xff\xff\xff\x0f";
const PUBLIC_MARKER = "\xf2\xff\xff\xff\x0f";
const WEAK_MARKER = "\xea\xff\xff\xff\x0f";

type Item = DescTree[number];

/**
 * Serialize a nested array of the names encoding into the bytes that
 * protoc-gen-es embeds. What the markers say by name is restored on the
 * way: `oneof_index` of real oneof members, the synthetic oneofs of proto3
 * `optional` fields, and `public_dependency` / `weak_dependency`, resolved
 * against `importNames`. Only file, message, field and oneof descriptors
 * are looked into; the rest of the tree is passed through as is.
 */
export function fromNamedTree(
  tree: DescTree,
  importNames: readonly string[],
): Uint8Array {
  // Chunks hold UTF-8 bytes, one char per byte.
  const names = importNames.map((n) =>
    String.fromCharCode(...new TextEncoder().encode(n)),
  );
  return fromTree(
    tree.map((item) => {
      if (typeof item !== "string") {
        return item[0] === MESSAGE_TYPE ? message(item, "") : item;
      }
      const tag = item.startsWith(PUBLIC_MARKER)
        ? PUBLIC_DEPENDENCY
        : item.startsWith(WEAK_MARKER)
          ? WEAK_DEPENDENCY
          : undefined;
      if (tag === undefined) {
        return item;
      }
      const name = markerValue(item);
      const index = names.indexOf(name);
      if (index < 0) {
        throw new Error(`unresolved import ${name}`);
      }
      return tag + varint(index);
    }),
  );
}

function message(node: readonly [string, DescTree], scope: string): Item {
  const [tag, children] = node;
  // Most messages have neither markers nor proto3 `optional` fields; they
  // are passed through unless a nested message changes.
  let changed = false;
  const oneofs: string[] = [];
  const fields: { name: string; optional: boolean }[] = [];
  for (const item of children) {
    if (typeof item === "string") {
      continue;
    }
    if (item[0] === ONEOF_DECL) {
      oneofs.push(nameOf(item[1]) ?? "");
    } else if (item[0] === FIELD) {
      let optional = false;
      for (const c of item[1]) {
        if (typeof c !== "string") {
          continue;
        }
        if (c.startsWith(ONEOF_MARKER)) {
          changed = true;
        } else if (c.includes(PROTO3_OPTIONAL_TRUE) && proto3Optional(c)) {
          optional = changed = true;
        }
      }
      fields.push({ name: optional ? (nameOf(item[1]) ?? "") : "", optional });
    }
  }
  const prefix = () => `${scope}${nameOf(children) ?? ""}.`;
  if (!changed) {
    let out: Item[] | undefined;
    for (let j = 0; j < children.length; j++) {
      const item = children[j];
      if (typeof item === "string" || item[0] !== NESTED_TYPE) {
        continue;
      }
      const nested = message(item, prefix());
      if (nested !== item) {
        out ??= [...children];
        out[j] = nested;
      }
    }
    return out === undefined ? node : [tag, out];
  }
  // The synthetic oneofs, named the way protoc names them: after the real
  // oneofs, in field order, `_` + field name, prefixed with `X` while that
  // collides.
  const taken = new Set([...fieldNames(children), ...oneofs]);
  const synthetic: string[] = [];
  let i = 0;
  const out: Item[] = children.map((item) => {
    if (typeof item === "string") {
      return item;
    }
    if (item[0] === NESTED_TYPE) {
      return message(item, prefix());
    }
    if (item[0] !== FIELD) {
      return item;
    }
    const f = fields[i++];
    let index: number | undefined;
    if (f.optional) {
      let oneof = f.name.startsWith("_") ? f.name : `_${f.name}`;
      while (taken.has(oneof)) {
        oneof = `X${oneof}`;
      }
      taken.add(oneof);
      index = oneofs.length + synthetic.push(oneof) - 1;
    }
    return field(item, oneofs, index, prefix());
  });
  for (const oneof of synthetic) {
    out.push([ONEOF_DECL, [NAME + varint(oneof.length) + oneof]]);
  }
  return [tag, out];
}

function fieldNames(children: DescTree): string[] {
  const names: string[] = [];
  for (const item of children) {
    if (typeof item !== "string" && item[0] === FIELD) {
      names.push(nameOf(item[1]) ?? "");
    }
  }
  return names;
}

function field(
  node: readonly [string, DescTree],
  oneofs: string[],
  syntheticIndex: number | undefined,
  messagePrefix: string,
): Item {
  let index = syntheticIndex;
  const out = node[1].filter((item) => {
    if (typeof item !== "string" || !item.startsWith(ONEOF_MARKER)) {
      return true;
    }
    const oneof = markerValue(item);
    if (index !== undefined) {
      throw new Error(
        `${messagePrefix}${nameOf(node[1])} is in several oneofs`,
      );
    }
    index = oneofs.indexOf(oneof);
    if (index < 0) {
      throw new Error(
        `unresolved oneof ${messagePrefix}${nameOf(node[1])} -> ${oneof}`,
      );
    }
    return false;
  });
  if (index === undefined) {
    return node;
  }
  return [node[0], [...out, ONEOF_INDEX + varint(index)]];
}

/** The `name = 1` string among a descriptor's chunks. */
function nameOf(children: DescTree): string | undefined {
  for (const item of children) {
    if (typeof item === "string" && item.startsWith(NAME)) {
      const [length, pos] = readVarint(item, 1);
      return item.slice(pos, pos + length);
    }
  }
  return undefined;
}

/** A marker chunk's value; a marker is always a chunk of its own. */
function markerValue(chunk: string): string {
  const [length, pos] = readVarint(chunk, ONEOF_MARKER.length);
  if (pos + length !== chunk.length) {
    throw new Error("a marker shares its chunk with another field");
  }
  return chunk.slice(pos);
}

/** Whether a chunk of fields sets `proto3_optional`. */
function proto3Optional(chunk: string): boolean {
  let set = false;
  let pos = 0;
  while (pos < chunk.length) {
    const [tag, afterTag] = readVarint(chunk, pos);
    const no = tag >>> 3;
    switch (tag & 7) {
      case 0: {
        const [value, next] = readVarint(chunk, afterTag);
        if (no === PROTO3_OPTIONAL) {
          set = value !== 0;
        }
        pos = next;
        break;
      }
      case 1:
        pos = afterTag + 8;
        break;
      case 2: {
        const [length, next] = readVarint(chunk, afterTag);
        pos = next + length;
        break;
      }
      case 5:
        pos = afterTag + 4;
        break;
      default:
        throw new Error(`unsupported wire type in ${JSON.stringify(chunk)}`);
    }
  }
  return set;
}

/** A varint of at most 32 bits at `pos`, and the position after it. */
function readVarint(s: string, pos: number): [number, number] {
  let value = 0;
  for (let shift = 0; ; shift += 7) {
    const byte = s.charCodeAt(pos++);
    value += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) {
      return [value, pos];
    }
  }
}

function varint(n: number): string {
  let s = "";
  while (n > 0x7f) {
    s += String.fromCharCode((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  return s + String.fromCharCode(n);
}
