import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  decodeDescriptorExpr,
  extractDescriptorExpr,
} from "../descriptor-expr.js";
import { formatOf, generate, VARIANTS } from "../generate.js";
import { bufBuild } from "../tools.js";

const testdataDir = fileURLToPath(new URL("testdata", import.meta.url));
const path = "example/v1/kitchen_sink.proto";

describe("manifest variants", () => {
  const [file] = generate(bufBuild(testdataDir, path), [path]);

  it("embed the same descriptor as their encoding", () => {
    const expected = decodeDescriptorExpr(
      extractDescriptorExpr(file.content.base64),
      "base64",
    );
    for (const variant of VARIANTS) {
      const expr = extractDescriptorExpr(file.content[variant]);
      expect(decodeDescriptorExpr(expr, formatOf(variant))).toEqual(expected);
    }
  });

  const manifestOf = (content: string) =>
    content
      .split("\n")
      .filter((line) =>
        /^\/\/ ([\d.]+: |[a-z -]+(of |in )?[\w.]*:$)/.test(line),
      );

  it("list every positional reference once, in headed blocks", () => {
    expect(manifestOf(file.content["b-manifest"])).toEqual([
      "// imports:",
      "// 0: google/protobuf/descriptor.proto",
      "// 1: google/protobuf/timestamp.proto",
      "// top-level messages:",
      "// 0: message example.v1.KitchenSink",
      "// messages nested in example.v1.KitchenSink:",
      "// 0.0: message example.v1.KitchenSink.Nested",
      "// enums nested in example.v1.KitchenSink:",
      "// 0.0: enum example.v1.KitchenSink.Kind",
      // oneof_index points here; the synthetic oneof of `optional ratio`
      // comes after the real one.
      "// oneofs of example.v1.KitchenSink:",
      "// 0: choice",
      "// 1: _ratio",
      "// messages nested in example.v1.KitchenSink.Nested:",
      "// 0.0.0: message example.v1.KitchenSink.Nested.Deeper",
      "// services:",
      "// 0: service example.v1.KitchenSinkService",
      "// top-level extensions:",
      "// 0: extension example.v1.redact",
      "// 1: extension example.v1.tags",
    ]);
    expect(manifestOf(file.content["a-manifest"])).toEqual(
      manifestOf(file.content["b-manifest"]),
    );
  });

  it("list only generated-code references in the index manifest", () => {
    const manifest = manifestOf(file.content["b-index-manifest"]);
    expect(manifest.filter((l) => /^\/\/ (imports|oneofs)/.test(l))).toEqual(
      [],
    );
    const calls = file.content.b.match(
      /(message|enum|service|ext)Desc\(file_\w+(, \d+)+\)/g,
    );
    expect(calls).toHaveLength(
      manifest.filter((l) => /^\/\/ \d/.test(l)).length,
    );
  });

  it("mark public and weak imports", () => {
    const proto = 'syntax = "proto3";\npackage p;\n';
    const dir = mkdtempSync(join(tmpdir(), "manifest-imports-"));
    try {
      mkdirSync(join(dir, "dep"));
      writeFileSync(
        join(dir, "dep/a.proto"),
        `${proto.replace("p;", "dep.a;")}`,
      );
      writeFileSync(
        join(dir, "dep/b.proto"),
        `${proto.replace("p;", "dep.b;")}`,
      );
      writeFileSync(
        join(dir, "main.proto"),
        `${proto}import "dep/a.proto";\nimport public "dep/b.proto";\nmessage M {}\n`,
      );
      const [main] = generate(bufBuild(dir, "main.proto"), ["main.proto"]);
      expect(manifestOf(main.content["b-manifest"]).slice(0, 3)).toEqual([
        "// imports:",
        "// 0: dep/a.proto",
        "// 1: dep/b.proto (public)",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
