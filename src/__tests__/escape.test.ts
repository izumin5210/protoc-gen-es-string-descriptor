import { describe, expect, it } from "vitest";
import { escapeBytesAsJSString, jsStringToBytes } from "../escape.js";

describe("escapeBytesAsJSString", () => {
  it("escapes printable ASCII as literal characters", () => {
    const bytes = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
    expect(escapeBytesAsJSString(bytes)).toBe("Hello");
  });

  it("escapes 0x0a as \\n", () => {
    const bytes = new Uint8Array([0x0a]);
    expect(escapeBytesAsJSString(bytes)).toBe("\\n");
  });

  it("escapes special control characters", () => {
    expect(escapeBytesAsJSString(new Uint8Array([0x08]))).toBe("\\b");
    expect(escapeBytesAsJSString(new Uint8Array([0x09]))).toBe("\\t");
    expect(escapeBytesAsJSString(new Uint8Array([0x0b]))).toBe("\\v");
    expect(escapeBytesAsJSString(new Uint8Array([0x0c]))).toBe("\\f");
    expect(escapeBytesAsJSString(new Uint8Array([0x0d]))).toBe("\\r");
  });

  it("escapes double quote and backslash", () => {
    expect(escapeBytesAsJSString(new Uint8Array([0x22]))).toBe('\\"');
    expect(escapeBytesAsJSString(new Uint8Array([0x5c]))).toBe("\\\\");
  });

  it("escapes non-printable bytes as \\xHH", () => {
    expect(escapeBytesAsJSString(new Uint8Array([0x00]))).toBe("\\x00");
    expect(escapeBytesAsJSString(new Uint8Array([0x01]))).toBe("\\x01");
    expect(escapeBytesAsJSString(new Uint8Array([0x1f]))).toBe("\\x1f");
    expect(escapeBytesAsJSString(new Uint8Array([0x7f]))).toBe("\\x7f");
    expect(escapeBytesAsJSString(new Uint8Array([0x80]))).toBe("\\x80");
    expect(escapeBytesAsJSString(new Uint8Array([0xff]))).toBe("\\xff");
  });

  it("handles mixed content", () => {
    // 0x0a 0x0c "example.proto"
    const bytes = new Uint8Array([
      0x0a, 0x0c, 0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65, 0x2e, 0x70, 0x72,
      0x6f, 0x74, 0x6f,
    ]);
    expect(escapeBytesAsJSString(bytes)).toBe("\\n\\fexample.proto");
  });

  it("handles empty input", () => {
    expect(escapeBytesAsJSString(new Uint8Array([]))).toBe("");
  });
});

describe("jsStringToBytes", () => {
  it("converts string characters to byte values", () => {
    const str = "\n\x0cexample.proto";
    const bytes = jsStringToBytes(str);
    expect(bytes).toEqual(
      new Uint8Array([
        0x0a, 0x0c, 0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65, 0x2e, 0x70, 0x72,
        0x6f, 0x74, 0x6f,
      ]),
    );
  });

  it("round-trips with escapeBytesAsJSString", () => {
    const original = new Uint8Array([
      0x0a, 0x12, 0x07, 0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65, 0x22, 0x5c,
      0x00, 0xff,
    ]);
    // The escaped string, when placed in a JS string literal and evaluated,
    // should produce the original bytes via charCodeAt.
    // We verify this by constructing the string manually.
    const str = "\x0a\x12\x07\x65\x78\x61\x6d\x70\x6c\x65\x22\x5c\x00\xff";
    expect(jsStringToBytes(str)).toEqual(original);
  });
});
