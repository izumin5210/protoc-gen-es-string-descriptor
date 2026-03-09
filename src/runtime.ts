import type { DescFile } from "@bufbuild/protobuf";
import { fileDesc as originalFileDesc } from "@bufbuild/protobuf/codegenv1";
import { base64Encode } from "@bufbuild/protobuf/wire";

/**
 * Drop-in replacement for `fileDesc` from `@bufbuild/protobuf/codegenv1`
 * that accepts raw byte strings instead of base64-encoded strings.
 *
 * Each character in the raw string represents a single byte (0x00-0xFF).
 */
export function fileDesc(raw: string, imports?: DescFile[]): DescFile {
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i);
  }
  return originalFileDesc(base64Encode(bytes, "std_raw"), imports);
}
