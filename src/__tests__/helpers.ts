import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { create, fromBinary } from "@bufbuild/protobuf";
import {
  CodeGeneratorRequestSchema,
  type FileDescriptorProto,
  FileDescriptorSetSchema,
} from "@bufbuild/protobuf/wkt";
import { protocGenEs } from "@bufbuild/protoc-gen-es/dist/cjs/src/protoc-gen-es-plugin.js";
import { plugin } from "../plugin.js";

const require = createRequire(import.meta.url);
const BUF = require.resolve("@bufbuild/buf/bin/buf");
const repoRoot = join(import.meta.dirname, "..", "..");

/**
 * `buf build` a directory into the descriptors that `buf generate` would
 * pass to a plugin. Throws with buf's message if the files do not compile.
 */
export function bufBuild(root: string): FileDescriptorProto[] {
  const outDir = mkdtempSync(join(tmpdir(), "buf-"));
  try {
    const out = join(outDir, "image.binpb");
    const result = spawnSync(
      process.execPath,
      [
        BUF,
        "build",
        root,
        "--as-file-descriptor-set",
        "--exclude-source-info",
        "-o",
        out,
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(`buf build failed: ${result.stderr}`);
    }
    return fromBinary(FileDescriptorSetSchema, readFileSync(out)).file;
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

export interface GeneratedFile {
  name: string;
  content: string;
}

/** Run this plugin, or protoc-gen-es itself with `original`. */
export function generate(
  protoFile: FileDescriptorProto[],
  fileToGenerate: string[],
  { parameter = "target=ts", original = false } = {},
): GeneratedFile[] {
  const request = create(CodeGeneratorRequestSchema, {
    fileToGenerate,
    protoFile,
    parameter,
  });
  return (original ? protocGenEs : plugin)
    .run(request)
    .file.map(({ name, content }) => ({ name, content }));
}

/**
 * Directory for generated code that must resolve this repository's
 * packages, as it would in a project that installs this package.
 */
export function makeWorkDir(prefix: string): string {
  const parent = join(repoRoot, ".tmp");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, prefix));
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
}
