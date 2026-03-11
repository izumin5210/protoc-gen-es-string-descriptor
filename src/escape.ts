/** biome-ignore-all lint/complexity/useSimpleNumberKeys: this is a simple lookup table for byte values */

const SPECIAL_ESCAPES: Record<number, string> = {
  0x08: "\\b",
  0x09: "\\t",
  0x0a: "\\n",
  0x0b: "\\v",
  0x0c: "\\f",
  0x0d: "\\r",
  0x22: '\\"',
  0x5c: "\\\\",
};

/**
 * Encode a byte array as a JavaScript string literal body (without surrounding quotes).
 * Similar to Go's fmt.Sprintf("%q", bytes) but for JS syntax.
 */
export function escapeBytesAsJSString(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) {
    const special = SPECIAL_ESCAPES[byte];
    if (special !== undefined) {
      result += special;
    } else if (byte >= 0x20 && byte <= 0x7e) {
      result += String.fromCharCode(byte);
    } else {
      result += `\\x${byte.toString(16).padStart(2, "0")}`;
    }
  }
  return result;
}

/**
 * Convert a raw byte string (where each character represents a byte value 0x00-0xFF)
 * back to a Uint8Array.
 */
export function jsStringToBytes(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i);
  }
  return bytes;
}
