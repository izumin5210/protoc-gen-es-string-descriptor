import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { fromBinary, create } from "@bufbuild/protobuf";
import {
  CodeGeneratorRequestSchema,
  FileDescriptorSetSchema,
} from "@bufbuild/protobuf/wkt";
import { base64Decode } from "@bufbuild/protobuf/wire";
import { protocGenEs } from "@bufbuild/protoc-gen-es/dist/cjs/src/protoc-gen-es-plugin.js";
import { plugin } from "../../plugin.js";
import { jsStringToBytes } from "../../escape.js";

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

function unescapeJSString(escaped: string): string {
  return escaped
    .replace(/\\x([0-9a-f]{2})/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\\b/g, "\b")
    .replace(/\\f/g, "\f")
    .replace(/\\v/g, "\v")
    .replace(/\\\\/g, "\\")
    .replace(/\\"/g, '"');
}

function extractFileDescBytes(content: string): Uint8Array[] {
  const results: Uint8Array[] = [];
  const callRe = /fileDesc\(((?:"(?:[^"\\]|\\.)*"(?:\s*\+\s*)?)+)/g;
  for (const callMatch of content.matchAll(callRe)) {
    const stringExpr = callMatch[1];
    const strRe = /"((?:[^"\\]|\\.)*)"/g;
    let combined = "";
    for (const strMatch of stringExpr.matchAll(strRe)) {
      combined += strMatch[1];
    }
    const unescaped = unescapeJSString(combined);
    results.push(jsStringToBytes(unescaped));
  }
  return results;
}

function extractBase64FileDescBytes(content: string): Uint8Array[] {
  const results: Uint8Array[] = [];
  const re = /fileDesc\("([A-Za-z0-9+/=]+)"/g;
  for (const match of content.matchAll(re)) {
    results.push(base64Decode(match[1]));
  }
  return results;
}

describe("Golden Tests", () => {
  beforeAll(() => {
    execFileSync("pnpm", [
      "buf",
      "build",
      testdataDir,
      "-o",
      join(testdataDir, "descriptor.binpb"),
    ], { shell: true });
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

    it("should preserve file descriptor bytes through transformation", () => {
      const request = buildCodeGeneratorRequest(protoFiles);
      const originalResponse = protocGenEs.run(request);
      const transformedResponse = plugin.run(request);

      for (const originalFile of originalResponse.file) {
        if (!originalFile.name || !originalFile.content) continue;

        const transformedFile = transformedResponse.file.find(
          (f) => f.name === originalFile.name,
        );
        expect(transformedFile).toBeDefined();
        expect(transformedFile!.content).toBeDefined();

        const originalBytes = extractBase64FileDescBytes(
          originalFile.content,
        );
        const transformedBytes = extractFileDescBytes(
          transformedFile!.content!,
        );

        expect(transformedBytes.length).toBe(originalBytes.length);
        for (let i = 0; i < originalBytes.length; i++) {
          expect(transformedBytes[i]).toEqual(originalBytes[i]);
        }
      }
    });
  });
});
