import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { toBinary } from "@bufbuild/protobuf";
import {
  enumDesc as enumDescByIndex,
  extDesc as extDescByIndex,
  messageDesc as messageDescByIndex,
  fileDesc as originalFileDesc,
  pathInFileDesc,
  serviceDesc as serviceDescByIndex,
} from "@bufbuild/protobuf/codegenv2";
import { nestedTypes } from "@bufbuild/protobuf/reflect";
import * as wkt from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import {
  extractDescriptorExpr,
  parseFileDescCall,
} from "../descriptor-expr.js";
import { generate, NAMES_RUNTIME } from "../generate.js";
import {
  enumDesc,
  extDesc,
  fileDesc,
  messageDesc,
  serviceDesc,
} from "../names/runtime.js";
import { assertRoundTrip } from "../replay-pair.js";
import { bufBuild } from "../tools.js";
import { typeErrors } from "../typecheck.js";

const testdataDir = fileURLToPath(new URL("testdata", import.meta.url));
const scenariosDir = fileURLToPath(new URL("../../scenarios", import.meta.url));
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");

function buildScenario(scenario: string, side: string): Uint8Array {
  const root = mkdtempSync(join(tmpdir(), "names-test-"));
  try {
    const dir = join(scenariosDir, scenario);
    if (existsSync(join(dir, "deps"))) {
      cpSync(join(dir, "deps"), root, { recursive: true });
    }
    writeFileSync(
      join(root, "m.proto"),
      readFileSync(join(dir, `${side}.proto`)),
    );
    return bufBuild(root, "m.proto");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const generateNames = () => {
  const image = bufBuild(testdataDir, "example/v1/names.proto");
  const [file] = generate(image, ["example/v1/names.proto"]);
  return file;
};

describe("names variants", () => {
  it.each([
    "example/v1/kitchen_sink.proto",
    "example/v1/names.proto",
  ])("round-trip %s byte for byte", (path) => {
    const [file] = generate(bufBuild(testdataDir, path), [path]);
    assertRoundTrip(file.content);
  });

  it.each(
    readdirSync(scenariosDir).flatMap((scenario) =>
      ["base", "ours", "theirs"].map((side) => ({ scenario, side })),
    ),
  )("round-trip scenario $scenario/$side byte for byte", ({
    scenario,
    side,
  }) => {
    const [file] = generate(buildScenario(scenario, side), ["m.proto"]);
    assertRoundTrip(file.content);
  });

  it("refer to oneofs and public imports by name", () => {
    const content = generateNames().content["b-names"];
    const { imports, names } = parseFileDescCall(
      extractDescriptorExpr(content),
      "names",
    );
    expect(imports).toEqual(["file_example_v1_dep_a", "file_example_v1_dep_b"]);
    expect(names).toEqual([
      ["oneof", "Collide.x", "X_foo"],
      ["oneof", "Collide.click", "kind"],
      ["oneof", "Collide.a", "kind"],
      ["public", "file_example_v1_dep_b"],
    ]);
    expect(content).toContain(
      'messageDesc(file_example_v1_names, "Collide.Inner")',
    );
    expect(content).toContain(
      `import { enumDesc, fileDesc, messageDesc } from "${NAMES_RUNTIME}";`,
    );
  });

  it("emit number types except for map entries and allow_alias enums", () => {
    const content = generateNames().content["b-names-numbers"];
    expect(content.match(/^type _numbers_\w+/gm)).toEqual([
      "type _numbers_example_v1_Collide",
      "type _numbers_example_v1_Collide_Inner",
      "type _numbers_example_v1_Level",
    ]);
    expect(generateNames().content["b-names"]).not.toContain("_numbers_");
  });
});

describe("names runtime", () => {
  const sources = [
    {
      path: "example/v1/kitchen_sink.proto",
      imports: [
        wkt.file_google_protobuf_descriptor,
        wkt.file_google_protobuf_timestamp,
      ],
    },
    {
      path: "example/v1/names.proto",
      imports: ["a", "b"].map((name) =>
        originalFileDesc(
          generate(bufBuild(testdataDir, `example/v1/dep/${name}.proto`), [
            `example/v1/dep/${name}.proto`,
          ])[0].content.base64.match(/fileDesc\("([^"]+)"/)![1],
        ),
      ),
    },
  ];

  it.each(sources)("hydrates $path like the original runtime", ({
    path,
    imports,
  }) => {
    const [file] = generate(bufBuild(testdataDir, path), [path]);
    const call = (variant: "b-names" | "b-index-manifest-numbers") => {
      const { arg, names } = parseFileDescCall(
        extractDescriptorExpr(file.content[variant]),
        "names",
      );
      const byId = (id: string) =>
        imports.find(
          (f) => `file_${f.name.replace(/[^a-zA-Z0-9_]+/g, "_")}` === id,
        )!;
      return fileDesc(
        arg as Parameters<typeof fileDesc>[0],
        imports,
        names.map((e) => (e[0] === "oneof" ? e : [e[0], byId(e[1])])),
      );
    };
    const original = originalFileDesc(
      file.content.base64.match(/fileDesc\("([^"]+)"/)![1],
      imports,
    );
    const bytes = (f: typeof original) =>
      toBinary(wkt.FileDescriptorProtoSchema, f.proto);
    expect(bytes(call("b-names"))).toEqual(bytes(original));
    expect(bytes(call("b-index-manifest-numbers"))).toEqual(bytes(original));
  });

  it.each(sources)("looks up every element of $path by name", ({
    path,
    imports,
  }) => {
    const [file] = generate(bufBuild(testdataDir, path), [path]);
    const desc = originalFileDesc(
      file.content.base64.match(/fileDesc\("([^"]+)"/)![1],
      imports,
    );
    const prefix = `${desc.proto.package}.`;
    for (const element of nestedTypes(desc)) {
      const name = element.typeName.slice(prefix.length);
      const [first, ...rest] = pathInFileDesc(element);
      const [byName, byIndex] = {
        message: () => [
          messageDesc(desc, name),
          messageDescByIndex(desc, first, ...rest),
        ],
        enum: () => [
          enumDesc(desc, name),
          enumDescByIndex(desc, first, ...rest),
        ],
        service: () => [
          serviceDesc(desc, name),
          serviceDescByIndex(desc, first, ...rest),
        ],
        extension: () => [
          extDesc(desc, name),
          extDescByIndex(desc, first, ...rest),
        ],
      }[element.kind]();
      expect(byName).toBe(element);
      expect(byIndex).toBe(element);
    }
    expect(() => messageDesc(desc, "Missing")).toThrow(/not found/);
  });
});

describe("number types", () => {
  const content = generateNames().content["b-names-numbers"];
  const duplicate = content.replace('  2: "_foo";', '  1: "_foo";');

  it("type-check as generated", () => {
    expect(typeErrors(content)).toEqual([]);
  });

  it("make a duplicate field number a TS2300 error", () => {
    expect(typeErrors(duplicate).filter((e) => e.startsWith("TS2300"))).toEqual(
      [
        "TS2300: Duplicate identifier '1'.",
        "TS2300: Duplicate identifier '1'.",
      ],
    );
  });

  it("fail the tsc command line the same way", () => {
    const dir = mkdtempSync(join(tmpdir(), "names-tsc-"));
    try {
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "names_pb.ts"), duplicate);
      const run = spawnSync(
        process.execPath,
        [
          tsc,
          "--noEmit",
          "--strict",
          "--target",
          "es2022",
          "--module",
          "esnext",
          "--moduleResolution",
          "bundler",
          "src/names_pb.ts",
        ],
        { cwd: dir, encoding: "utf8" },
      );
      const errors = run.stdout
        .split("\n")
        .filter((line) => / error TS2300/.test(line));
      expect(errors).toEqual([
        expect.stringMatching(
          /names_pb\.ts\(\d+,3\): error TS2300: Duplicate identifier '1'\./,
        ),
        expect.stringMatching(
          /names_pb\.ts\(\d+,3\): error TS2300: Duplicate identifier '1'\./,
        ),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
