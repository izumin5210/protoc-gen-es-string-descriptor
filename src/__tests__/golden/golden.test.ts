import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { fromBinary, create } from "@bufbuild/protobuf";
import {
  CodeGeneratorRequestSchema,
  FileDescriptorSetSchema,
} from "@bufbuild/protobuf/wkt";
import { plugin } from "../../plugin.js";

const testdataDir = join(import.meta.dirname, "testdata");
const snapshotsDir = join(import.meta.dirname, "__snapshots__");

interface TestCase {
  name: string;
  protoFiles: string[];
}

const testCases: TestCase[] = [
  { name: "simple", protoFiles: ["simple.proto"] },
  { name: "nested", protoFiles: ["nested.proto"] },
];

function buildCodeGeneratorRequest(protoFiles: string[]) {
  const descriptorPath = join(testdataDir, "descriptor.binpb");
  const fdsBytes = readFileSync(descriptorPath);
  const fds = fromBinary(FileDescriptorSetSchema, fdsBytes);
  return create(CodeGeneratorRequestSchema, {
    fileToGenerate: protoFiles,
    protoFile: fds.file,
    parameter: "target=ts",
  });
}

describe("Golden Tests", () => {
  beforeAll(() => {
    execFileSync("pnpm", [
      "buf",
      "build",
      testdataDir,
      "-o",
      join(testdataDir, "descriptor.binpb"),
    ]);
  });

  describe.each(testCases)("$name", ({ protoFiles }) => {
    it("should generate files matching golden snapshots", async () => {
      const request = buildCodeGeneratorRequest(protoFiles);
      const response = plugin.run(request);

      for (const file of response.file) {
        if (file.name && file.content) {
          await expect(file.content).toMatchFileSnapshot(
            join(snapshotsDir, file.name),
          );
        }
      }
    });

});
});
