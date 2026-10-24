import { fileURLToPath } from "node:url";
import { toBinary } from "@bufbuild/protobuf";
import {
  type GenFile,
  fileDesc as originalFileDesc,
} from "@bufbuild/protobuf/codegenv2";
import * as wkt from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import {
  decodeDescriptorExpr,
  extractDescriptorExpr,
  parseDescriptorArg,
} from "../descriptor-expr.js";
import { ENCODINGS, generate, OPTION_B_RUNTIME } from "../generate.js";
import { fileDesc as fileDescADirect } from "../option-a-direct.js";
import { renderTree, toTree } from "../option-b/encode.js";
import { type DescTree, fileDesc, fromTree } from "../option-b/runtime.js";
import { fileDesc as fileDescBDirect } from "../option-b/runtime-direct.js";
import { bufBuild } from "../tools.js";

const testdataDir = fileURLToPath(new URL("testdata", import.meta.url));
const conflictDemoDir = fileURLToPath(
  new URL("../../conflict-demo", import.meta.url),
);

function evaluateTree(expr: string): DescTree {
  // The top-level array is the only one closed at column 0.
  const literal = expr.slice("fileDesc(".length, expr.indexOf("\n]") + 2);
  return new Function(`return ${literal}`)();
}

const wktFiles = Object.entries(wkt)
  .filter(([name]) => name.startsWith("file_"))
  .map(([name, file]) => ({
    name,
    bytes: toBinary(wkt.FileDescriptorProtoSchema, (file as GenFile).proto),
  }));

describe("toTree / fromTree", () => {
  it.each(wktFiles)("round-trips $name", ({ bytes }) => {
    const rendered = `fileDesc([\n${renderTree(toTree(bytes))}\n]);`;
    expect(fromTree(evaluateTree(rendered))).toEqual(bytes);
    expect(decodeDescriptorExpr(rendered, "b")).toEqual(bytes);
  });

  it("keeps unknown fields such as option extensions raw", () => {
    const image = bufBuild(testdataDir, "example/v1/kitchen_sink.proto");
    const [file] = generate(image, ["example/v1/kitchen_sink.proto"]);
    // (redact) is field 50001 of FieldOptions, i.e. tag 0x8a 0xb5 0x18.
    expect(file.content.b).toContain(
      [
        '   ["B", [',
        '    "\\x8a\\xb5\\x18\\x07\\x00\\n\\"\\\\ \\xc3\\xa9",',
        "   ]],",
      ].join("\n"),
    );
  });
});

describe("generate", () => {
  const cases = [
    { root: testdataDir, path: "example/v1/kitchen_sink.proto" },
    ...[
      "same-service-different-rpcs",
      "same-message-different-fields",
      "message-inserted-next-to-changed-message",
      "control-different-messages",
    ].flatMap((scenario) =>
      ["ours.proto", "theirs.proto"].map((file) => ({
        root: `${conflictDemoDir}/${scenario}`,
        path: file,
      })),
    ),
  ];

  it.each(cases)("all encodings embed the same bytes for $root/$path", ({
    root,
    path,
  }) => {
    const [file] = generate(bufBuild(root, path), [path]);
    const expected = decodeDescriptorExpr(
      extractDescriptorExpr(file.content.base64),
      "base64",
    );
    for (const encoding of ENCODINGS) {
      const expr = extractDescriptorExpr(file.content[encoding]);
      expect(decodeDescriptorExpr(expr, encoding)).toEqual(expected);
    }
    expect(
      fromTree(evaluateTree(extractDescriptorExpr(file.content.b))),
    ).toEqual(expected);
  });

  it("rewrites the fileDesc import to the Option B runtime", () => {
    const image = bufBuild(testdataDir, "example/v1/kitchen_sink.proto");
    const [file] = generate(image, ["example/v1/kitchen_sink.proto"]);
    expect(file.content.b).toContain(
      `import { fileDesc } from "${OPTION_B_RUNTIME}";`,
    );
    expect(file.content.b).not.toMatch(
      /\{[^}]*\bfileDesc\b[^}]*\} from "@bufbuild/,
    );
  });
});

describe("fileDesc", () => {
  it("hydrates the same descriptor as the original runtime", () => {
    const image = bufBuild(testdataDir, "example/v1/kitchen_sink.proto");
    const [file] = generate(image, ["example/v1/kitchen_sink.proto"]);
    const tree = evaluateTree(extractDescriptorExpr(file.content.b));
    const desc = fileDesc(tree, [
      wkt.file_google_protobuf_descriptor,
      wkt.file_google_protobuf_timestamp,
    ]);
    const message = desc.messages[0];
    expect(message.typeName).toBe("example.v1.KitchenSink");
    expect(message.field.jsonNameOverride.jsonName).toBe("override");
    expect(message.field.name.jsonName).toBe("name");
    expect(message.nestedMessages.map((m) => m.name)).toContain("Nested");
    expect(desc.services[0].methods.map((m) => m.name)).toEqual([
      "Get",
      "Stream",
    ]);
  });

  it("direct runtimes hydrate the same descriptor as the original", () => {
    const image = bufBuild(testdataDir, "example/v1/kitchen_sink.proto");
    const [file] = generate(image, ["example/v1/kitchen_sink.proto"]);
    const imports = [
      wkt.file_google_protobuf_descriptor,
      wkt.file_google_protobuf_timestamp,
    ];
    const arg = (encoding: "base64" | "a" | "b") =>
      parseDescriptorArg(
        extractDescriptorExpr(file.content[encoding]),
        encoding,
      );
    const serialize = (desc: ReturnType<typeof fileDesc>) =>
      toBinary(wkt.FileDescriptorProtoSchema, desc.proto);
    const expected = serialize(
      originalFileDesc(arg("base64") as string, imports),
    );
    expect(serialize(fileDescADirect(arg("a") as string, imports))).toEqual(
      expected,
    );
    expect(serialize(fileDescBDirect(arg("b") as DescTree, imports))).toEqual(
      expected,
    );
  });
});
