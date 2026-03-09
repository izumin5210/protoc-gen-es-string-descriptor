import { describe, expect, it } from "vitest";
import { splitAfter } from "../split.js";

describe("splitAfter", () => {
  it("returns single chunk for empty array", () => {
    const result = splitAfter(new Uint8Array([]), 0x0a);
    expect(result).toEqual([]);
  });

  it("returns single chunk when separator is not found", () => {
    const bytes = new Uint8Array([0x01, 0x02, 0x03]);
    const result = splitAfter(bytes, 0x0a);
    expect(result).toEqual([new Uint8Array([0x01, 0x02, 0x03])]);
  });

  it("splits after separator at the beginning", () => {
    const bytes = new Uint8Array([0x0a, 0x01, 0x02]);
    const result = splitAfter(bytes, 0x0a);
    expect(result).toEqual([
      new Uint8Array([0x0a]),
      new Uint8Array([0x01, 0x02]),
    ]);
  });

  it("splits after separator at the end", () => {
    const bytes = new Uint8Array([0x01, 0x02, 0x0a]);
    const result = splitAfter(bytes, 0x0a);
    expect(result).toEqual([new Uint8Array([0x01, 0x02, 0x0a])]);
  });

  it("splits after multiple separators", () => {
    const bytes = new Uint8Array([0x0a, 0x01, 0x02, 0x0a, 0x03, 0x0a]);
    const result = splitAfter(bytes, 0x0a);
    expect(result).toEqual([
      new Uint8Array([0x0a]),
      new Uint8Array([0x01, 0x02, 0x0a]),
      new Uint8Array([0x03, 0x0a]),
    ]);
  });

  it("handles consecutive separators", () => {
    const bytes = new Uint8Array([0x0a, 0x0a, 0x0a]);
    const result = splitAfter(bytes, 0x0a);
    expect(result).toEqual([
      new Uint8Array([0x0a]),
      new Uint8Array([0x0a]),
      new Uint8Array([0x0a]),
    ]);
  });

  it("handles trailing data after last separator", () => {
    const bytes = new Uint8Array([0x0a, 0x01, 0x0a, 0x02, 0x03]);
    const result = splitAfter(bytes, 0x0a);
    expect(result).toEqual([
      new Uint8Array([0x0a]),
      new Uint8Array([0x01, 0x0a]),
      new Uint8Array([0x02, 0x03]),
    ]);
  });
});
