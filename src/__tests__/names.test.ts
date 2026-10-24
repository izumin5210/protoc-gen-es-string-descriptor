import { clone, create, toBinary } from "@bufbuild/protobuf";
import {
  type FileDescriptorProto,
  FileDescriptorProtoSchema,
} from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { extractNames, restoreNames } from "../names.js";

const imports = ["file_a", "file_b", "file_c"];

function file(): FileDescriptorProto {
  return create(FileDescriptorProtoSchema, {
    name: "m.proto",
    publicDependency: [2],
    weakDependency: [0],
    messageType: [
      {
        name: "M",
        field: [
          { name: "a", number: 1, oneofIndex: 0 },
          { name: "b", number: 2, oneofIndex: 1, proto3Optional: true },
          { name: "c", number: 3 },
        ],
        oneofDecl: [{ name: "kind" }, { name: "_b" }],
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

describe("extractNames", () => {
  it("moves positions into names and drops synthetic oneofs", () => {
    const f = file();
    expect(extractNames(f, imports)).toEqual([
      ["oneof", "M.a", "kind"],
      ["oneof", "M.N.x", "inner"],
      ["public", "file_c"],
      ["weak", "file_a"],
    ]);
    expect(f.publicDependency).toEqual([]);
    expect(f.weakDependency).toEqual([]);
    expect(f.messageType[0].oneofDecl.map((o) => o.name)).toEqual(["kind"]);
    expect(f.messageType[0].field.map((field) => field.oneofIndex)).toEqual([
      0, 0, 0,
    ]);
  });

  it("rejects a synthetic oneof before a real one", () => {
    const f = file();
    f.messageType[0].oneofDecl.reverse();
    f.messageType[0].field[0].oneofIndex = 1;
    f.messageType[0].field[1].oneofIndex = 0;
    expect(() => extractNames(f, imports)).toThrow(
      "synthetic oneof before a real one in M",
    );
  });
});

describe("restoreNames", () => {
  it("restores what extractNames moved out", () => {
    const original = file();
    const f = clone(FileDescriptorProtoSchema, original);
    const names = extractNames(f, imports);
    restoreNames(f, names, imports);
    expect(toBinary(FileDescriptorProtoSchema, f)).toEqual(
      toBinary(FileDescriptorProtoSchema, original),
    );
  });

  it("prefixes synthetic oneof names with X while they collide", () => {
    const f = create(FileDescriptorProtoSchema, {
      messageType: [
        {
          name: "M",
          field: [
            { name: "_v", number: 1 },
            { name: "v", number: 2, proto3Optional: true },
            { name: "_w", number: 3, proto3Optional: true },
          ],
          oneofDecl: [{ name: "X_v" }],
        },
      ],
    });
    restoreNames(f, [], []);
    expect(f.messageType[0].oneofDecl.map((o) => o.name)).toEqual([
      "X_v",
      "XX_v",
      "X_w",
    ]);
  });

  it.each([
    [
      ["oneof", "M.missing", "kind"],
      "unresolved oneof member M.missing -> kind",
    ],
    [["oneof", "M.a", "missing"], "unresolved oneof member M.a -> missing"],
    [["public", "file_d"], "unresolved public import in m.proto"],
  ] as const)("throws for %j", (entry, message) => {
    const f = file();
    extractNames(f, imports);
    expect(() => restoreNames(f, [entry], imports)).toThrow(message);
  });
});
