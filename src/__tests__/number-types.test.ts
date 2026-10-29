import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bufBuild, generate, tscErrors } from "./helpers.js";

const protos = bufBuild(join(import.meta.dirname, "golden", "testdata"));
const toGenerate = protos
  .map((f) => f.name)
  .filter((name) => !name.startsWith("google/"));
const generated = (parameter: string) =>
  Object.fromEntries(
    generate(protos, toGenerate, { parameter }).map((f) => [f.name, f.content]),
  );

describe("number types", () => {
  it.each([
    "target=ts",
    "target=js+dts",
    "target=dts",
  ])("type-check with noUnusedLocals for %s", (parameter) => {
    expect(tscErrors(generated(parameter))).toEqual([]);
  }, 60_000);

  it("are only in .ts and .d.ts files", () => {
    for (const [name, content] of Object.entries({
      ...generated("target=js+dts"),
      ...generated("target=ts"),
    })) {
      expect(content.includes("export type _numbers_"), name).toBe(
        !name.endsWith(".js"),
      );
    }
  });

  it("leave out map entries and enums with allow_alias", () => {
    const { "map_pb.ts": map, "extensions_pb.ts": extensions } =
      generated("target=ts");
    expect(map.match(/^export type _numbers_\w+/gm)).toEqual([
      "export type _numbers_testdata_Inventory",
      "export type _numbers_testdata_Inventory_Item",
      "export type _numbers_testdata_Availability",
    ]);
    expect(extensions).not.toContain("_numbers_testdata_Legacy");
  });

  it("make a duplicate number in a .d.ts file a TS2300 error", () => {
    const files = generated("target=dts");
    files["simple_pb.d.ts"] = files["simple_pb.d.ts"].replace(
      '  2: "age";',
      '  1: "age";',
    );
    expect(tscErrors(files)).toEqual([
      expect.stringMatching(
        /simple_pb\.d\.ts\(\d+,3\): error TS2300: Duplicate identifier '1'\.$/,
      ),
      expect.stringMatching(
        /simple_pb\.d\.ts\(\d+,3\): error TS2300: Duplicate identifier '1'\.$/,
      ),
      expect.stringMatching(/error TS2717: /),
    ]);
  }, 60_000);
});
