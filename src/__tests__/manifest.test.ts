import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
    expect(manifest.map(({ kind, path }) => ({ kind, path }))).toEqual(
      calls.map(({ kind, path }) => ({ kind, path })),
    );
    for (const [i, call] of calls.entries()) {
      if (call.name !== undefined) {
        expect(manifest[i].name).toBe(call.name);
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

  it("follows the fileDesc statement", () => {
    expect(content).toMatch(
      /fileDesc\([\s\S]*?\);\n\n\/\/ Index manifest: [\s\S]*?\n\/\/ 0: message testdata\.manifest\.Person\n/,
    );
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
  // ours inserts Profile before Team (Team: 1 -> 2); theirs appends Invoice at
  // index 2. Without the manifest, git merges both and InvoiceSchema ends up
  // pointing at Team.
  function merge(parameter: string) {
    const sides = Object.fromEntries(
      ["base", "ours", "theirs"].map((side) => {
        const dir = mkdtempSync(join(tmp, `${side}-`));
        copyFileSync(
          join(mergeDir, `${side}.proto`),
          join(dir, "library.proto"),
        );
        const path = join(dir, "library_pb.ts");
        writeFileSync(path, generateTs(dir, "library.proto", parameter));
        return [side, path];
      }),
    );
    const result = spawnSync(
      "git",
      ["merge-file", "-p", sides.ours, sides.base, sides.theirs],
      { encoding: "utf8" },
    );
    return { status: result.status, text: result.stdout };
  }

  it("conflicts when both sides renumber the same list", () => {
    const { status, text } = merge("target=ts");
    expect(status).toBeGreaterThan(0);
    expect(text).toMatch(
      /<<<<<<< [\s\S]*\/\/ 2: message example\.v1\.Team[\s\S]*>>>>>>> /,
    );
  });

  it("would otherwise merge cleanly into a wrong index", () => {
    const { status, text } = merge("target=ts,index_manifest=false");
    expect(status).toBe(0);
    expect(text).toContain(
      "export const InvoiceSchema: GenMessage<Invoice> = /*@__PURE__*/\n  messageDesc(file_library, 2);",
    );
    expect(text).toContain(
      "export const TeamSchema: GenMessage<Team> = /*@__PURE__*/\n  messageDesc(file_library, 2);",
    );
  });
});
