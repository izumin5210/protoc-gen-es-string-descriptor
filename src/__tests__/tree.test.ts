import { toBinary } from "@bufbuild/protobuf";
import { BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import {
  FileDescriptorProtoSchema,
  file_google_protobuf_descriptor,
} from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { evaluateTree, fromTree, renderTree, toTree } from "../tree.js";

describe("toTree and fromTree", () => {
  it("round-trip a large descriptor", () => {
    const bytes = toBinary(
      FileDescriptorProtoSchema,
      file_google_protobuf_descriptor.proto,
    );
    expect(fromTree(evaluateTree(toTree(bytes)))).toEqual(bytes);
  });

  it("keep unknown fields raw, each length-delimited one on its own", () => {
    const bytes = new BinaryWriter()
      .tag(1, WireType.LengthDelimited)
      .string("a.proto")
      .tag(4, WireType.LengthDelimited)
      .fork()
      .tag(1, WireType.LengthDelimited)
      .string("M")
      .join()
      .tag(99, WireType.LengthDelimited)
      .string("x")
      .tag(100, WireType.Varint)
      .int32(1)
      .finish();
    const tree = evaluateTree(toTree(bytes));
    expect(tree).toEqual([
      "\n\x07a.proto",
      ['"', ["\n\x01M"]],
      "\x9a\x06\x01x",
      "\xa0\x06\x01",
    ]);
    expect(fromTree(tree)).toEqual(bytes);
  });
});

describe("renderTree", () => {
  it("puts every element on its own line with a trailing comma", () => {
    const bytes = new BinaryWriter()
      .tag(1, WireType.LengthDelimited)
      .string("a.proto")
      .tag(4, WireType.LengthDelimited)
      .fork()
      .tag(1, WireType.LengthDelimited)
      .string("M")
      .tag(9, WireType.LengthDelimited)
      .fork()
      .join()
      .join()
      .finish();
    expect(renderTree(toTree(bytes))).toEqual([
      ' "\\n\\x07a.proto",',
      ' ["\\"", [',
      '  "\\n\\x01M",',
      '  ["J", [',
      "  ]],",
      " ]],",
    ]);
  });
});
