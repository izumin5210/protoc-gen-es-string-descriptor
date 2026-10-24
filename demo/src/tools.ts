import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUF = createRequire(import.meta.url).resolve("@bufbuild/buf/bin/buf");

/**
 * `buf build` a single file (with its imports) from a directory without a
 * buf.yaml. Source info is excluded because protoc-gen-es strips it anyway.
 */
export function bufBuild(root: string, path: string): Uint8Array {
  const outDir = mkdtempSync(join(tmpdir(), "buf-"));
  const out = join(outDir, "image.binpb");
  const result = spawnSync(
    BUF,
    ["build", ".", "--path", path, "--exclude-source-info", "-o", out],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`buf build failed: ${result.stderr}`);
  }
  const image = readFileSync(out);
  rmSync(outDir, { recursive: true, force: true });
  return image;
}

export interface MergeResult {
  text: string;
  conflicts: number;
}

/** Three-way merge of in-memory texts with `git merge-file -p`. */
export function mergeFile(
  ours: string,
  base: string,
  theirs: string,
): MergeResult {
  const dir = mkdtempSync(join(tmpdir(), "merge-"));
  try {
    const paths = { ours, base, theirs };
    for (const [name, text] of Object.entries(paths)) {
      writeFileSync(join(dir, name), text);
    }
    const result = spawnSync(
      "git",
      [
        "merge-file",
        "-p",
        ...["-L", "ours", "-L", "base", "-L", "theirs"],
        ...["ours", "base", "theirs"].map((name) => join(dir, name)),
      ],
      { encoding: "utf8", maxBuffer: 1 << 30 },
    );
    if (result.status === null || result.status < 0 || result.status > 127) {
      throw new Error(`git merge-file failed: ${result.stderr}`);
    }
    const text = result.stdout;
    const conflicts = text.match(/^<<<<<<< /gm)?.length ?? 0;
    return { text, conflicts };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Unified diff of two texts, without the file header. */
export function diffText(before: string, after: string, context = 1): string {
  const dir = mkdtempSync(join(tmpdir(), "diff-"));
  try {
    writeFileSync(join(dir, "before"), before);
    writeFileSync(join(dir, "after"), after);
    const result = spawnSync(
      "git",
      ["diff", "--no-index", `-U${context}`, "before", "after"],
      { cwd: dir, encoding: "utf8" },
    );
    return result.stdout.replace(/^[\s\S]*?(?=^@@)/m, "").trimEnd();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
