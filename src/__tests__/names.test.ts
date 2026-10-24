import { clone, create, toBinary } from "@bufbuild/protobuf";
import { BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import {
  type FileDescriptorProto,
  FileDescriptorProtoSchema,
} from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { embedNames, restoreNames } from "../names.js";

const dependency = ["a.proto", "b.proto", "c.proto"];

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

function marker(no: number, value: string) {
  return {
    no,
    wireType: WireType.LengthDelimited,
    data: new BinaryWriter().string(value).finish(),
  };
}

describe("embedNames", () => {
  it("marks oneof members and imports by name and drops synthetic oneofs", () => {
    const f = file();
    embedNames(f, dependency);
    const [m] = f.messageType;
    expect(f.$unknown).toEqual([
      marker(536870910, "c.proto"),
      marker(536870909, "a.proto"),
    ]);
    expect(f.publicDependency).toEqual([]);
    expect(f.weakDependency).toEqual([]);
    expect(m.oneofDecl.map((o) => o.name)).toEqual(["kind"]);
    expect(m.field.map((field) => field.$unknown)).toEqual([
      [marker(536870911, "kind")],
      undefined,
      undefined,
    ]);
    expect(m.nestedType[0].field[0].$unknown).toEqual([
      marker(536870911, "inner"),
    ]);
    expect(m.field.map((field) => field.oneofIndex)).toEqual([0, 0, 0]);
  });

  it("needs the file name of every public or weak import", () => {
    expect(() => embedNames(file(), [])).toThrow(
      "m.proto: no file name for import 2",
    );
  });

  it("rejects a synthetic oneof before a real one", () => {
    const f = file();
    f.messageType[0].oneofDecl.reverse();
    f.messageType[0].field[0].oneofIndex = 1;
    f.messageType[0].field[1].oneofIndex = 0;
    expect(() => embedNames(f, dependency)).toThrow(
      "synthetic oneof before a real one in M",
    );
  });
});

describe("restoreNames", () => {
  const embedded = () => {
    const f = file();
    embedNames(f, dependency);
    f.dependency = [...dependency];
    return f;
  };

  it("restores what embedNames replaced", () => {
    const original = file();
    original.dependency = [...dependency];
    const f = embedded();
    restoreNames(f);
    expect(f.$unknown).toBeUndefined();
    expect(toBinary(FileDescriptorProtoSchema, f)).toEqual(
      toBinary(FileDescriptorProtoSchema, original),
    );
  });

  it("keeps other unknown fields", () => {
    const f = embedded();
    const other = marker(100, "x");
    f.$unknown = [other, ...f.$unknown!];
    restoreNames(f);
    expect(f.$unknown).toEqual([other]);
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
    restoreNames(f);
    expect(f.messageType[0].oneofDecl.map((o) => o.name)).toEqual([
      "X_v",
      "XX_v",
      "X_w",
    ]);
  });

  it("throws for a oneof that is not in the message", () => {
    const f = embedded();
    f.messageType[0].oneofDecl = [];
    expect(() => restoreNames(f)).toThrow(
      "unresolved oneof member M.a -> kind",
    );
  });

  it("throws for a field in several oneofs", () => {
    const f = embedded();
    const field = f.messageType[0].field[0];
    field.$unknown = [...field.$unknown!, marker(536870911, "kind")];
    expect(() => restoreNames(f)).toThrow("M.a is in several oneofs");
  });

  it("throws for an import that is not imported", () => {
    const f = clone(FileDescriptorProtoSchema, embedded());
    f.dependency = ["a.proto"];
    expect(() => restoreNames(f)).toThrow(
      "m.proto: unresolved public import c.proto",
    );
  });
});
