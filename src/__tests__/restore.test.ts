import { clone, create, toBinary } from "@bufbuild/protobuf";
import { BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import {
  type FileDescriptorProto,
  FileDescriptorProtoSchema,
} from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { embedNames } from "../names.js";
import { evaluateTree, fromTree, toTree } from "../tree.js";

// fromTree restores at the byte level what embedNames replaced. Each case
// starts from a descriptor as protoc-gen-es embeds it (without dependency),
// and expects exactly its bytes back.

const dependency = ["a.proto", "b.proto", "c.proto"];

function original(): FileDescriptorProto {
  return create(FileDescriptorProtoSchema, {
    name: "m.proto",
    publicDependency: [2, 1],
    weakDependency: [0],
    syntax: "proto3",
    messageType: [
      {
        name: "M",
        field: [
          { name: "a", number: 1, oneofIndex: 0, jsonName: "aa" },
          { name: "b", number: 2, oneofIndex: 2, proto3Optional: true },
          { name: "c", number: 3, options: { deprecated: true } },
          { name: "d", number: 4, oneofIndex: 1 },
        ],
        oneofDecl: [{ name: "kind" }, { name: "other" }, { name: "_b" }],
        reservedName: ["r"],
        nestedType: [
          {
            name: "N",
            field: [{ name: "x", number: 1, oneofIndex: 0 }],
            oneofDecl: [{ name: "inner" }],
          },
        ],
      },
    ],
  });
}

/** The tree that generated code passes to the runtime. */
function embed(file: FileDescriptorProto): ReturnType<typeof evaluateTree> {
  const f = clone(FileDescriptorProtoSchema, file);
  embedNames(f, dependency);
  return evaluateTree(toTree(toBinary(FileDescriptorProtoSchema, f)));
}

function marker(no: number, value: string) {
  return {
    no,
    wireType: WireType.LengthDelimited,
    data: new BinaryWriter().string(value).finish(),
  };
}

describe("fromTree", () => {
  it("restores oneof members, synthetic oneofs and imports byte for byte", () => {
    const file = original();
    expect(fromTree(embed(file), dependency)).toEqual(
      toBinary(FileDescriptorProtoSchema, file),
    );
  });

  it("prefixes synthetic oneof names with X while they collide", () => {
    const file = create(FileDescriptorProtoSchema, {
      messageType: [
        {
          name: "M",
          field: [
            { name: "_v", number: 1, oneofIndex: 0 },
            { name: "v", number: 2, oneofIndex: 1, proto3Optional: true },
            { name: "_w", number: 3, oneofIndex: 2, proto3Optional: true },
          ],
          oneofDecl: [{ name: "X_v" }, { name: "XX_v" }, { name: "X_w" }],
        },
      ],
    });
    expect(fromTree(embed(file))).toEqual(
      toBinary(FileDescriptorProtoSchema, file),
    );
  });

  it("keeps other unknown fields after the restored ones", () => {
    const file = original();
    file.$unknown = [marker(100, "file")];
    file.messageType[0].field[0].$unknown = [marker(100, "field")];
    expect(fromTree(embed(file), dependency)).toEqual(
      toBinary(FileDescriptorProtoSchema, file),
    );
  });

  it("resolves import names as UTF-8", () => {
    const file = create(FileDescriptorProtoSchema, {
      name: "m.proto",
      publicDependency: [0],
    });
    const f = clone(FileDescriptorProtoSchema, file);
    embedNames(f, ["dép/ü.proto"]);
    const tree = evaluateTree(toTree(toBinary(FileDescriptorProtoSchema, f)));
    expect(fromTree(tree, ["dép/ü.proto"])).toEqual(
      toBinary(FileDescriptorProtoSchema, file),
    );
  });

  it("throws for a oneof that is not in the message", () => {
    const tree = embed(original());
    const renamed = JSON.parse(
      JSON.stringify(tree).replace("\\n\\u0004kind", "\\n\\u0004KIND"),
    );
    expect(() => fromTree(renamed, dependency)).toThrow(
      "unresolved oneof member M.a -> kind",
    );
  });

  it("throws for a field in several oneofs", () => {
    const file = original();
    file.messageType[0].field[0].$unknown = [marker(536870911, "other")];
    expect(() => fromTree(embed(file), dependency)).toThrow(
      "M.a is in several oneofs",
    );
  });

  it("throws for an import that is not imported", () => {
    expect(() => fromTree(embed(original()), ["a.proto", "b.proto"])).toThrow(
      "unresolved public import c.proto",
    );
  });
});
