import { describe, expect, it } from "vitest";
import { base64Encode } from "@bufbuild/protobuf/wire";
import { transformFileContent } from "../transform.js";
import { jsStringToBytes } from "../escape.js";

describe("transformFileContent", () => {
  it("does not modify code without fileDesc", () => {
    const code = `import { messageDesc } from "@bufbuild/protobuf/codegenv1";
export const UserSchema = messageDesc(file_example, 0);`;
    expect(transformFileContent(code)).toBe(code);
  });

  it("transforms a simple fileDesc call", () => {
    // 0x0a 0x05 "hello" 0x12 0x03 "foo"
    const bytes = new Uint8Array([
      0x0a, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x12, 0x03, 0x66, 0x6f,
      0x6f,
    ]);
    const b64 = base64Encode(bytes, "std_raw");

    const input = `  fileDesc("${b64}");`;
    const result = transformFileContent(input);

    // Should be multi-line
    expect(result).toContain('" +');
    // Should NOT contain the original base64 string on a single line
    expect(result).not.toContain(`fileDesc("${b64}")`);
  });

  it("transforms fileDesc with dependencies", () => {
    const bytes = new Uint8Array([0x0a, 0x03, 0x66, 0x6f, 0x6f]);
    const b64 = base64Encode(bytes, "std_raw");

    const input = `  fileDesc("${b64}", [file_dep1, file_dep2]);`;
    const result = transformFileContent(input);

    // Dependencies should be preserved
    expect(result).toContain("[file_dep1, file_dep2]");
    // Should be multi-line
    expect(result).toContain('" +');
  });

  it("preserves byte-level correctness after transformation", () => {
    const originalBytes = new Uint8Array([
      0x0a, 0x0c, 0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65, 0x2e, 0x70,
      0x72, 0x6f, 0x74, 0x6f, 0x12, 0x07, 0x65, 0x78, 0x61, 0x6d, 0x70,
      0x6c, 0x65, 0x1a, 0x0a, 0x0a, 0x04, 0x55, 0x73, 0x65, 0x72, 0x12,
      0x02, 0x0a, 0x00,
    ]);
    const b64 = base64Encode(originalBytes, "std_raw");

    const input = `  fileDesc("${b64}");`;
    const result = transformFileContent(input);

    // Extract the raw string content from the transformed output
    const stringParts: string[] = [];
    const regex = /"([^"]*)"/g;
    let match;
    while ((match = regex.exec(result)) !== null) {
      stringParts.push(match[1]);
    }
    const rawString = stringParts.join("");

    // Unescape the JS string escapes to get the actual byte values
    const unescaped = rawString
      .replace(/\\x([0-9a-f]{2})/g, (_, hex: string) =>
        String.fromCharCode(parseInt(hex, 16)),
      )
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\r/g, "\r")
      .replace(/\\b/g, "\b")
      .replace(/\\f/g, "\f")
      .replace(/\\v/g, "\v")
      .replace(/\\\\/g, "\\")
      .replace(/\\"/g, '"');

    const reconstructed = jsStringToBytes(unescaped);
    expect(reconstructed).toEqual(originalBytes);
  });

  it("rewrites fileDesc import from codegenv1", () => {
    const bytes = new Uint8Array([0x0a, 0x01, 0x61]);
    const b64 = base64Encode(bytes, "std_raw");

    const input = `import { fileDesc, messageDesc } from "@bufbuild/protobuf/codegenv1";
export const file_example = fileDesc("${b64}");`;

    const result = transformFileContent(input);

    expect(result).toContain(
      'import { fileDesc } from "protoc-gen-es-string-descriptor/runtime"',
    );
    expect(result).toContain(
      'import { messageDesc } from "@bufbuild/protobuf/codegenv1"',
    );
    expect(result).not.toContain(
      'import { fileDesc, messageDesc } from "@bufbuild/protobuf/codegenv1"',
    );
  });

  it("rewrites fileDesc import from codegenv2", () => {
    const bytes = new Uint8Array([0x0a, 0x01, 0x61]);
    const b64 = base64Encode(bytes, "std_raw");

    const input = `import { fileDesc, messageDesc } from "@bufbuild/protobuf/codegenv2";
export const file_example = fileDesc("${b64}");`;

    const result = transformFileContent(input);

    expect(result).toContain(
      'import { fileDesc } from "protoc-gen-es-string-descriptor/runtime"',
    );
    expect(result).toContain(
      'import { messageDesc } from "@bufbuild/protobuf/codegenv2"',
    );
  });

  it("handles fileDesc as the only import", () => {
    const bytes = new Uint8Array([0x0a, 0x01, 0x61]);
    const b64 = base64Encode(bytes, "std_raw");

    const input = `import { fileDesc } from "@bufbuild/protobuf/codegenv1";
export const file_example = fileDesc("${b64}");`;

    const result = transformFileContent(input);

    expect(result).toContain(
      'import { fileDesc } from "protoc-gen-es-string-descriptor/runtime"',
    );
    // The original import line should be removed entirely
    expect(result).not.toContain('@bufbuild/protobuf/codegenv1"');
  });

  it("does not modify type imports", () => {
    const input = `import type { GenFile } from "@bufbuild/protobuf/codegenv1";`;
    const result = transformFileContent(input);
    expect(result).toBe(input);
  });

  it("does not split when no 0x0a byte is present", () => {
    // Bytes that don't contain 0x0a
    const bytes = new Uint8Array([0x12, 0x03, 0x66, 0x6f, 0x6f]);
    const b64 = base64Encode(bytes, "std_raw");

    const input = `  fileDesc("${b64}");`;
    const result = transformFileContent(input);

    // Should still be transformed to raw string format but on a single line
    expect(result).not.toContain('" +');
    expect(result).toContain("fileDesc(");
  });

  it("handles multiple fileDesc calls in one file", () => {
    const bytes1 = new Uint8Array([0x0a, 0x01, 0x61]);
    const bytes2 = new Uint8Array([0x0a, 0x01, 0x62]);
    const b641 = base64Encode(bytes1, "std_raw");
    const b642 = base64Encode(bytes2, "std_raw");

    const input = `  fileDesc("${b641}");
  fileDesc("${b642}");`;
    const result = transformFileContent(input);

    // Both should be transformed
    expect(result).not.toContain(b641);
    expect(result).not.toContain(b642);
  });
});
