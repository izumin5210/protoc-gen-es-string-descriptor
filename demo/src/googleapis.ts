import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** googleapis/googleapis commit that all results in this directory used. */
export const GOOGLEAPIS_REV = "4792db7b61d0d1430f5bc33463bbe90254f3d5f6";

const workDir = join(import.meta.dirname, "..", ".work");

/**
 * Partial clone (commits and trees only, blobs on demand) so that history
 * can be walked without downloading every revision of every file.
 */
export function cloneGoogleapis(): string {
  const dir = process.env["GOOGLEAPIS_DIR"] ?? join(workDir, "googleapis");
  if (!existsSync(dir)) {
    mkdirSync(workDir, { recursive: true });
    execFileSync(
      "git",
      [
        "clone",
        "--filter=blob:none",
        "--no-checkout",
        "https://github.com/googleapis/googleapis.git",
        dir,
      ],
      { stdio: "inherit" },
    );
  }
  return dir;
}

export function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });
}

/** `git show rev:path`, or undefined if the path does not exist there. */
export function showFile(
  repo: string,
  rev: string,
  path: string,
): string | undefined {
  const result = spawnSync("git", ["-C", repo, "show", `${rev}:${path}`], {
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });
  return result.status === 0 ? result.stdout : undefined;
}

const IMPORT_RE = /^\s*import\s+(?:public\s+|weak\s+)?"([^"]+)"\s*;/gm;

/**
 * Write `path` with the given content plus its transitive imports at `rev`
 * into a fresh directory. Well-known types are left to buf's built-ins.
 */
export function materialize(
  repo: string,
  rev: string,
  path: string,
  content: string,
): { root: string; key: string } {
  const files = new Map<string, string>([[path, content]]);
  const queue = [content];
  for (let src = queue.pop(); src !== undefined; src = queue.pop()) {
    for (const [, dep] of src.matchAll(IMPORT_RE)) {
      if (files.has(dep) || dep.startsWith("google/protobuf/")) {
        continue;
      }
      const depContent = showFile(repo, rev, dep);
      if (depContent === undefined) {
        throw new Error(`${dep} not found at ${rev}`);
      }
      files.set(dep, depContent);
      queue.push(depContent);
    }
  }
  const root = mkdtempSync(join(tmpdir(), "googleapis-"));
  for (const [file, text] of files) {
    mkdirSync(join(root, dirname(file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  const key = [...files.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, text]) => `${file}\0${text}`)
    .join("\0");
  return { root, key };
}
