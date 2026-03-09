/**
 * Split a byte array after every occurrence of the given separator byte.
 * Equivalent to Go's bytes.SplitAfter.
 */
export function splitAfter(bytes: Uint8Array, separator: number): Uint8Array[] {
  if (bytes.length === 0) {
    return [];
  }
  const chunks: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === separator) {
      chunks.push(bytes.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < bytes.length) {
    chunks.push(bytes.slice(start));
  }
  return chunks;
}
