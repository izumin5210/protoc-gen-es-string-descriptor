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
const TSC = require.resolve("typescript/bin/tsc");
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

/** `bufBuild` for in-memory `.proto` files. */
export function bufBuildFiles(
  files: Record<string, string>,
): FileDescriptorProto[] {
  const root = mkdtempSync(join(tmpdir(), "protos-"));
  try {
    writeFiles(root, files);
    return bufBuild(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
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

export interface MergeResult {
  text: string;
  conflicts: number;
}

/** Three-way merge of in-memory texts with `git merge-file`. */
export function mergeFile(
  ours: string,
  base: string,
  theirs: string,
): MergeResult {
  const dir = mkdtempSync(join(tmpdir(), "merge-"));
  try {
    writeFiles(dir, { ours, base, theirs });
    const result = spawnSync(
      "git",
      [
        "merge-file",
        "-p",
        ...["-L", "ours", "-L", "base", "-L", "theirs"],
        ...["ours", "base", "theirs"].map((name) => join(dir, name)),
      ],
      { encoding: "utf8" },
    );
    // The exit status is the number of conflicts, or negative on error.
    if (result.status === null || result.status < 0 || result.status > 127) {
      throw new Error(`git merge-file failed: ${result.stderr}`);
    }
    return {
      text: result.stdout,
      conflicts: result.stdout.match(/^<<<<<<< /gm)?.length ?? 0,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

/**
 * Type-check generated files with the `tsc` command line and strict
 * settings, including `noUnusedLocals` and without `skipLibCheck`. Returns
 * one line per error.
 */
export function tscErrors(files: Record<string, string>): string[] {
  const dir = makeWorkDir("tsc-");
  try {
    writeFiles(dir, {
      ...files,
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          noUnusedLocals: true,
          noUnusedParameters: true,
          noEmit: true,
          skipLibCheck: false,
          types: [],
          paths: {
            "protoc-gen-es-string-descriptor": [
              join(repoRoot, "src", "runtime.ts"),
            ],
          },
        },
        include: ["**/*.ts"],
      }),
    });
    const result = spawnSync(process.execPath, [TSC, "-p", dir], {
      encoding: "utf8",
    });
    return result.stdout
      .split("\n")
      .filter((line) => / error TS\d+/.test(line))
      .map((line) => line.trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
}
