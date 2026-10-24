import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromBinary } from "@bufbuild/protobuf";
import {
  CodeGeneratorRequestSchema,
  type CodeGeneratorResponse,
  FileDescriptorSetSchema,
} from "@bufbuild/protobuf/wkt";
import { afterAll, describe, expect, it } from "vitest";
import { plugin } from "../plugin.js";

const goldenDir = join(import.meta.dirname, "golden", "testdata");
const mergeDir = join(import.meta.dirname, "merge");
const tmp = mkdtempSync(join(tmpdir(), "manifest-test-"));

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function build(dir: string, file: string): Uint8Array {
  const out = join(tmp, `${Math.random().toString(36).slice(2)}.binpb`);
  execFileSync(
    "pnpm",
    ["buf", "build", dir, "--path", join(dir, file), "-o", out],
    {
      shell: true,
    },
  );
  return readFileSync(out);
}

function generate(
  image: Uint8Array,
  file: string,
  parameter: string,
): CodeGeneratorResponse {
  return plugin.run(
    create(CodeGeneratorRequestSchema, {
      fileToGenerate: [file],
      protoFile: fromBinary(FileDescriptorSetSchema, image).file,
      parameter,
    }),
  );
}

function generateTs(dir: string, file: string, parameter = "target=ts") {
  const [out] = generate(build(dir, file), file, parameter).file;
  return out.content;
}

const CALL_RE =
  /\/\*\*\n((?: \*.*\n)*?) \*\/\nexport const \w+: [^=]*? = \/\*@__PURE__\*\/\n {2}(message|enum|service|ext)Desc\(file_\w+, ([\d, ]+)\);/g;
const MANIFEST_LINE_RE =
  /^\/\/ ([\d.]+): (message|enum|service|extension) (\S+)$/gm;

describe("index manifest", () => {
  const content = generateTs(goldenDir, "manifest.proto");

  it("lists every positional reference with the path protoc-gen-es passes", () => {
    const calls = [...content.matchAll(CALL_RE)].map(([, doc, kind, args]) => ({
      kind: kind === "ext" ? "extension" : kind,
      path: args.split(", ").join("."),
      // JSDoc names the full name, except for extensions.
      name: /@generated from (?:message|enum|service) (\S+)/.exec(doc)?.[1],
    }));
    const manifest = [...content.matchAll(MANIFEST_LINE_RE)].map(
      ([, path, kind, name]) => ({ kind, path, name }),
    );

    expect(calls.length).toBe(10);
    const key = ({ kind, path }: { kind: string; path: string }) =>
      `${kind} ${path}`;
    expect(manifest.map(key).sort()).toEqual(calls.map(key).sort());
    for (const call of calls) {
      if (call.name !== undefined) {
        expect(manifest.find((m) => key(m) === key(call))?.name).toBe(
          call.name,
        );
      }
    }
    expect(manifest).toContainEqual({
      kind: "message",
      path: "0.0",
      name: "testdata.manifest.Person.Address",
    });
    expect(manifest).toContainEqual({
      kind: "extension",
      path: "0.0.0",
      name: "testdata.manifest.Person.Address.label",
    });
  });

  it("follows the fileDesc statement, one headed block per list", () => {
    const start = content.indexOf("// Index manifest: ");
    expect(content.slice(0, start)).toMatch(/\);\n\n$/);
    const blocks = content
      .slice(start)
      .split("\n\n")[0]
      .split("\n")
      .filter((line) => line.endsWith(":"));
    expect(blocks).toEqual([
      "// top-level messages:",
      "// messages nested in testdata.manifest.Person:",
      "// enums nested in testdata.manifest.Person:",
      "// extensions nested in testdata.manifest.Person:",
      "// enums nested in testdata.manifest.Person.Address:",
      "// extensions nested in testdata.manifest.Person.Address:",
      "// top-level enums:",
      "// services:",
      "// top-level extensions:",
    ]);
  });

  it("is added to the .js file of target=js+dts but not to the .d.ts file", () => {
    const files = generate(
      build(goldenDir, "manifest.proto"),
      "manifest.proto",
      "target=js+dts",
    ).file;
    const js = files.find((f) => f.name === "manifest_pb.js");
    const dts = files.find((f) => f.name === "manifest_pb.d.ts");
    expect(js?.content).toContain(
      "// 0.0: message testdata.manifest.Person.Address",
    );
    expect(dts?.content).not.toContain("Index manifest");
  });

  it("can be turned off with index_manifest=false", () => {
    const off = generateTs(
      goldenDir,
      "manifest.proto",
      "target=ts,index_manifest=false",
    );
    expect(off).not.toContain("Index manifest");
    expect(off).toBe(
      content.replace(/\n\/\/ Index manifest: [\s\S]*?\n(?=\n)/, ""),
    );
  });

  it("rejects an invalid index_manifest value", () => {
    expect(() =>
      generateTs(goldenDir, "manifest.proto", "target=ts,index_manifest=maybe"),
    ).toThrow(/index_manifest=maybe/);
  });

  it("is omitted when there is nothing to reference", () => {
    const dir = mkdtempSync(join(tmp, "empty-"));
    writeFileSync(
      join(dir, "empty.proto"),
      'syntax = "proto3";\npackage empty;\n',
    );
    expect(generateTs(dir, "empty.proto")).not.toContain("Index manifest");
  });
});

describe("merging generated code", () => {
  function mergeFile(ours: string, base: string, theirs: string) {
    const dir = mkdtempSync(join(tmp, "merge-"));
    const paths = { ours, base, theirs };
    for (const [name, text] of Object.entries(paths)) {
      writeFileSync(join(dir, name), text);
    }
    const result = spawnSync(
      "git",
      [
        "merge-file",
        "-p",
        ...["ours", "base", "theirs"].map((n) => join(dir, n)),
      ],
      { encoding: "utf8" },
    );
    return { conflicts: result.status ?? -1, text: result.stdout };
  }

  // Generates the scenario's three sides and the merged .proto, then merges
  // the generated files.
  function merge(scenario: string, parameter: string) {
    const proto = (side: string) =>
      readFileSync(join(mergeDir, scenario, `${side}.proto`), "utf8");
    const protoMerge = mergeFile(proto("ours"), proto("base"), proto("theirs"));
    expect(protoMerge.conflicts).toBe(0);
    const generated = (text: string) => {
      const dir = mkdtempSync(join(tmp, `${scenario}-`));
      writeFileSync(join(dir, "library.proto"), text);
      return generateTs(dir, "library.proto", parameter);
    };
    const result = mergeFile(
      generated(proto("ours")),
      generated(proto("base")),
      generated(proto("theirs")),
    );
    return { ...result, expected: generated(protoMerge.text) };
  }

  it("conflicts when one side inserts and the other appends", () => {
    // ours inserts Profile before Team (Team: 1 -> 2); theirs appends Invoice
    // at index 2. Without the manifest, git merges both and InvoiceSchema
    // ends up pointing at Team.
    const { conflicts, text } = merge("insert-vs-append", "target=ts");
    expect(conflicts).toBeGreaterThan(0);
    expect(text).toMatch(
      /<<<<<<< [\s\S]*\/\/ 2: message example\.v1\.Team[\s\S]*>>>>>>> /,
    );
  });

  it("would otherwise merge cleanly into a wrong index", () => {
    const { conflicts, text, expected } = merge(
      "insert-vs-append",
      "target=ts,index_manifest=false",
    );
    expect(conflicts).toBe(0);
    expect(text).toContain(
      "export const InvoiceSchema: GenMessage<Invoice> = /*@__PURE__*/\n  messageDesc(file_library, 2);",
    );
    expect(expected).toContain(
      "export const InvoiceSchema: GenMessage<Invoice> = /*@__PURE__*/\n  messageDesc(file_library, 3);",
    );
  });

  it("conflicts when one side moves a message and the other appends to its nested messages", () => {
    // Team: 1 -> 2 on ours; theirs adds messageDesc(file, 1, 1) for Invite.
    const { conflicts, text } = merge(
      "parent-shift-vs-nested-append",
      "target=ts",
    );
    expect(conflicts).toBeGreaterThan(0);
    expect(text).toMatch(
      /<<<<<<< [\s\S]*\/\/ 2\.0: message example\.v1\.Team\.Member[\s\S]*>>>>>>> /,
    );
  });

  it("does not conflict when neighbouring lists change at their boundary", () => {
    // ours renumbers every enum; theirs every service. The lists are
    // independent, and the header of the services block keeps them apart.
    const { conflicts, text, expected } = merge(
      "neighbouring-lists",
      "target=ts",
    );
    expect(conflicts).toBe(0);
    expect(text).toBe(expected);
  });
});
