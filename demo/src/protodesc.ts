import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clone, create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  type FileDescriptorProto,
  FileDescriptorProtoSchema,
  FileDescriptorSetSchema,
} from "@bufbuild/protobuf/wkt";

const sourceDir = join(import.meta.dirname, "..", "protodesc-check");
const binary = join(import.meta.dirname, "..", ".work", "protodesc-check");
let built: boolean | undefined;

/** Build the Go checker once; false if Go is not installed. */
function ensureBuilt(): boolean {
  if (built === undefined) {
    mkdirSync(join(binary, ".."), { recursive: true });
    const result = spawnSync(
      process.env["GO"] ?? "go",
      ["build", "-o", binary, "."],
      { cwd: sourceDir, encoding: "utf8" },
    );
    built = result.status === 0;
  }
  return built;
}

export function protodescAvailable(): boolean {
  return ensureBuilt();
}

/**
 * Load an embedded descriptor the way protobuf-go would load it: with its
 * `dependency` restored from the imports (as protobuf-es's `fileDesc` does)
 * and its real dependencies alongside. Returns "ok", protobuf-go's error,
 * or undefined if Go is not available.
 */
export function protodescCheck(
  embedded: Uint8Array,
  source: FileDescriptorProto,
  dependencies: FileDescriptorProto[],
): string | undefined {
  if (!ensureBuilt()) {
    return undefined;
  }
  const file = fromBinary(FileDescriptorProtoSchema, embedded);
  file.dependency = [...source.dependency];
  const set = create(FileDescriptorSetSchema, {
    file: [
      ...dependencies.map((d) => clone(FileDescriptorProtoSchema, d)),
      file,
    ],
  });
  const dir = mkdtempSync(join(tmpdir(), "protodesc-"));
  try {
    const path = join(dir, "set.binpb");
    writeFileSync(path, toBinary(FileDescriptorSetSchema, set));
    const result = spawnSync(binary, [path], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`protodesc-check failed: ${result.stderr}`);
    }
    // protobuf-go randomly swaps spaces in error messages for U+00A0 per
    // build, to keep callers from matching on them.
    return result.stdout.trim().replaceAll("\u00a0", " ");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
