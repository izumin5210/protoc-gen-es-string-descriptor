import { create, toBinary } from "@bufbuild/protobuf";
import { base64Encode } from "@bufbuild/protobuf/wire";
import {
  type FileDescriptorProto,
  FileDescriptorProtoSchema,
} from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { transformFileContent } from "../transform.js";

const proto = create(FileDescriptorProtoSchema, {
  name: "m.proto",
  package: "example.v1",
  messageType: [
    {
      name: "User",
      field: [
        { name: "id", number: 1 },
        { name: "email", number: 3 },
      ],
      nestedType: [
        { name: "TagsEntry", options: { mapEntry: true } },
        { name: "Address", field: [{ name: "city", number: 1 }] },
      ],
      enumType: [
        {
          name: "Role",
          value: [
            { name: "ROLE_UNSPECIFIED", number: 0 },
            { name: "ROLE_NONE", number: -1 },
          ],
        },
      ],
    },
  ],
  enumType: [
    {
      name: "Alias",
      options: { allowAlias: true },
      value: [
        { name: "A", number: 0 },
        { name: "B", number: 0 },
      ],
    },
  ],
  service: [{ name: "UserService" }],
  dependency: ["dep.proto"],
  publicDependency: [0],
});

function fileDescCall(file: FileDescriptorProto, deps: string): string {
  const b64 = base64Encode(
    toBinary(FileDescriptorProtoSchema, file),
    "std_raw",
  );
  return `fileDesc("${b64}"${deps});\n`;
}

const generatedTs = `import type { GenFile } from "@bufbuild/protobuf/codegenv2";
import { enumDesc, fileDesc, messageDesc, serviceDesc, tsEnum } from "@bufbuild/protobuf/codegenv2";
import { file_dep } from "./dep_pb";

export const file_m: GenFile = /*@__PURE__*/
  ${fileDescCall({ ...proto, dependency: [] }, ", [file_dep]")}
export const UserSchema = /*@__PURE__*/
  messageDesc(file_m, 0);
export const User_AddressSchema = /*@__PURE__*/
  messageDesc(file_m, 0, 0);
export const User_RoleSchema = /*@__PURE__*/
  enumDesc(file_m, 0, 0);
export const User_Role = /*@__PURE__*/
  tsEnum(User_RoleSchema);
export const UserService = /*@__PURE__*/
  serviceDesc(file_m, 0);
`;

describe("transformFileContent", () => {
  it("leaves code without fileDesc alone", () => {
    const code = `import { messageDesc } from "@bufbuild/protobuf/codegenv2";\n`;
    expect(transformFileContent(code)).toBe(code);
  });

  it("rewrites a .ts file", () => {
    expect(
      transformFileContent(generatedTs, { source: proto, numberTypes: true }),
    ).toBe(
      `import type { GenFile } from "@bufbuild/protobuf/codegenv2";
import { tsEnum } from "@bufbuild/protobuf/codegenv2";
import { enumDesc, fileDesc, messageDesc, serviceDesc } from "protoc-gen-es-string-descriptor";
import { file_dep } from "./dep_pb";

export const file_m: GenFile = /*@__PURE__*/
  fileDesc([
 "\\n\\x07m.proto",
 "\\x12\\nexample.v1",
 ["\\"", [
  "\\n\\x04User",
  ["\\x12", [
   "\\n\\x02id",
   "\\x18\\x01",
  ]],
  ["\\x12", [
   "\\n\\x05email",
   "\\x18\\x03",
  ]],
  ["\\x1a", [
   "\\n\\tTagsEntry",
   [":", [
    "8\\x01",
   ]],
  ]],
  ["\\x1a", [
   "\\n\\x07Address",
   ["\\x12", [
    "\\n\\x04city",
    "\\x18\\x01",
   ]],
  ]],
  ["\\"", [
   "\\n\\x04Role",
   ["\\x12", [
    "\\n\\x10ROLE_UNSPECIFIED",
    "\\x10\\x00",
   ]],
   ["\\x12", [
    "\\n\\tROLE_NONE",
    "\\x10\\xff\\xff\\xff\\xff\\xff\\xff\\xff\\xff\\xff\\x01",
   ]],
  ]],
 ]],
 ["*", [
  "\\n\\x05Alias",
  ["\\x12", [
   "\\n\\x01A",
   "\\x10\\x00",
  ]],
  ["\\x12", [
   "\\n\\x01B",
   "\\x10\\x00",
  ]],
  ["\\x1a", [
   "\\x10\\x01",
  ]],
 ]],
 ["2", [
  "\\n\\vUserService",
 ]],
 "\\xf2\\xff\\xff\\xff\\x0f\\tdep.proto",
], [
 file_dep,
]);
export type _numbers_example_v1_User = {
  1: "id";
  3: "email";
};
export type _numbers_example_v1_User_Role = {
  0: "ROLE_UNSPECIFIED";
  "-1": "ROLE_NONE";
};
export type _numbers_example_v1_User_Address = {
  1: "city";
};

export const UserSchema = /*@__PURE__*/
  messageDesc(file_m, "User");
export const User_AddressSchema = /*@__PURE__*/
  messageDesc(file_m, "User.Address");
export const User_RoleSchema = /*@__PURE__*/
  enumDesc(file_m, "User.Role");
export const User_Role = /*@__PURE__*/
  tsEnum(User_RoleSchema);
export const UserService = /*@__PURE__*/
  serviceDesc(file_m, "UserService");
`,
    );
  });

  it("emits no number types without numberTypes, as for .js", () => {
    const result = transformFileContent(generatedTs, { source: proto });
    expect(result).not.toContain("_numbers_");
    expect(result).toContain('messageDesc(file_m, "User.Address")');
  });

  it("emits number types after the GenFile declaration of a .d.ts file", () => {
    const dts = `import type { GenFile } from "@bufbuild/protobuf/codegenv2";

export declare const file_m: GenFile;

export declare type User = {};
`;
    expect(
      transformFileContent(dts, { source: proto, numberTypes: true }),
    ).toBe(`import type { GenFile } from "@bufbuild/protobuf/codegenv2";

export declare const file_m: GenFile;
export type _numbers_example_v1_User = {
  1: "id";
  3: "email";
};
export type _numbers_example_v1_User_Role = {
  0: "ROLE_UNSPECIFIED";
  "-1": "ROLE_NONE";
};
export type _numbers_example_v1_User_Address = {
  1: "city";
};

export declare type User = {};
`);
  });

  it("replaces the codegenv2 import when everything moves", () => {
    const code = `import { fileDesc } from "@bufbuild/protobuf/codegenv2";\n${fileDescCall(
      create(FileDescriptorProtoSchema, { name: "e.proto" }),
      "",
    )}`;
    expect(transformFileContent(code)).toBe(
      `import { fileDesc } from "protoc-gen-es-string-descriptor";
fileDesc([
 "\\n\\x07e.proto",
], [
]);
`,
    );
  });

  it("needs the source file for the names of public imports", () => {
    expect(() => transformFileContent(fileDescCall(proto, ""))).toThrow(
      "m.proto: no file name for import 0",
    );
  });

  it("rewrites only the calls that protoc-gen-es generates", () => {
    const call = "messageDesc(file_m, 9)";
    const file = create(FileDescriptorProtoSchema, {
      name: "e.proto",
      messageType: [
        { name: "M", field: [{ name: "f", number: 1, defaultValue: call }] },
      ],
    });
    const code = `/**\n * ${call}\n */\n${fileDescCall(file, "")}`;
    expect(transformFileContent(code)).toContain(call);
    expect(transformFileContent(code)).toContain(`\n * ${call}\n`);
  });

  it("names number types without an empty package", () => {
    const file = create(FileDescriptorProtoSchema, {
      name: "e.proto",
      messageType: [{ name: "M" }],
    });
    expect(
      transformFileContent(fileDescCall(file, ""), {
        source: file,
        numberTypes: true,
      }),
    ).toContain("export type _numbers_M = {\n};\n");
  });

  it("throws for a path that names no element", () => {
    const code = `${fileDescCall(
      create(FileDescriptorProtoSchema, { name: "e.proto" }),
      "",
    )}  messageDesc(file_m, 3);\n`;
    expect(() => transformFileContent(code)).toThrow(
      "no element for messageDesc(file_m, 3)",
    );
  });
});
