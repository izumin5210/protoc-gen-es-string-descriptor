import type { DescFile } from "@bufbuild/protobuf";
import { fileDesc as originalFileDesc } from "@bufbuild/protobuf/codegenv2";
import { base64Encode } from "@bufbuild/protobuf/wire";

/**
 * Each string is raw wire bytes (one char per byte). Each pair is the tag of
 * a sub-message field followed by the sub-message, whose length prefix is
 * recomputed here.
 */
export type DescTree = ReadonlyArray<string | readonly [string, DescTree]>;

/**
 * Drop-in replacement for `fileDesc` from `@bufbuild/protobuf/codegenv2` that
 * accepts a length-less tree instead of a base64 string.
 */
export function fileDesc(tree: DescTree, imports?: DescFile[]): DescFile {
  return originalFileDesc(base64Encode(fromTree(tree), "std_raw"), imports);
}

/**
 * Two passes, so that the output is a single allocation: first the body size
 * of every sub-message in pre-order, then the bytes.
 */
export function fromTree(tree: DescTree): Uint8Array {
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
