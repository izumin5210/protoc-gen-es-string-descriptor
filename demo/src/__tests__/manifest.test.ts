import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  decodeDescriptorExpr,
  extractDescriptorExpr,
} from "../descriptor-expr.js";
import { encodingOf, generate, VARIANTS } from "../generate.js";
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
      expect(decodeDescriptorExpr(expr, encodingOf(variant))).toEqual(expected);
    }
  });

  it("list every positional reference once, in headed blocks", () => {
    const manifest = file.content["a-manifest"]
      .split("\n")
      .filter((line) => /^\/\/ ([\d.]+: |[a-z -]+(in [\w.]+)?:$)/.test(line));
    expect(manifest).toEqual([
      "// top-level messages:",
      "// 0: message example.v1.KitchenSink",
      "// messages nested in example.v1.KitchenSink:",
      "// 0.0: message example.v1.KitchenSink.Nested",
      "// enums nested in example.v1.KitchenSink:",
      "// 0.0: enum example.v1.KitchenSink.Kind",
      "// messages nested in example.v1.KitchenSink.Nested:",
      "// 0.0.0: message example.v1.KitchenSink.Nested.Deeper",
      "// services:",
      "// 0: service example.v1.KitchenSinkService",
      "// top-level extensions:",
      "// 0: extension example.v1.redact",
      "// 1: extension example.v1.tags",
    ]);
    const calls = file.content.a.match(
      /(message|enum|service|ext)Desc\(file_\w+(, \d+)+\)/g,
    );
    expect(calls).toHaveLength(
      manifest.filter((l) => /^\/\/ \d/.test(l)).length,
    );
  });
});
