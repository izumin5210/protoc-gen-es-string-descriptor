import { create } from "@bufbuild/protobuf";
import { BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import {
  type FileDescriptorProto,
  FileDescriptorProtoSchema,
} from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { embedNames } from "../names.js";

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
