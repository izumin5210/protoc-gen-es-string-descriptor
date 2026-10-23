/**
 * Replay consecutive commit pairs of frequently edited googleapis files as if
 * they had been made concurrently, and merge the generated descriptors.
 *
 * Usage: pnpm --filter demo replay [pairs per file, default 40]
 */
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { equalBytes } from "../src/bytes.js";
import {
  decodeDescriptorExpr,
  extractDescriptorExpr,
} from "../src/descriptor-expr.js";
import { ENCODINGS, type Encoding, generate } from "../src/generate.js";
import {
  cloneGoogleapis,
  GOOGLEAPIS_REV,
  git,
  materialize,
  showFile,
} from "../src/googleapis.js";
import { type EncodingOutcome, replayPair } from "../src/replay-pair.js";
import { bufBuild, mergeFile } from "../src/tools.js";

const TARGETS = [
  "google/container/v1/cluster_service.proto",
  "google/pubsub/v1/pubsub.proto",
  "google/cloud/deploy/v1/cloud_deploy.proto",
];
const PAIRS = Number(process.argv[2] ?? 40);
const resultsDir = join(import.meta.dirname, "..", "results", "replay");

type PairRecord = {
  c1: string;
  c2: string;
  subjects: [string, string];
} & (
  | { status: "rebase-conflict" | "semantic-conflict" | "no-base" }
  | { status: "build-failure"; error: string }
  | {
      status: "replayed";
      /** One side's descriptor equals base (e.g. a comment-only change). */
      trivial: boolean;
      encodings: Record<Encoding, Omit<EncodingOutcome, "merged">>;
    }
);

const repo = cloneGoogleapis();
const imageCache = new Map<string, Uint8Array>();

function build(rev: string, path: string, content: string): Uint8Array {
  const { root, key } = materialize(repo, rev, path, content);
  try {
    const hash = createHash("sha256").update(key).digest("hex");
    let image = imageCache.get(hash);
    if (image === undefined) {
      image = bufBuild(root, path);
      imageCache.set(hash, image);
    }
    return image;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function embedded(image: Uint8Array, path: string): Uint8Array {
  const [file] = generate(image, [path]);
  return decodeDescriptorExpr(
    extractDescriptorExpr(file.content.base64),
    "base64",
  );
}

function replay(path: string, c1: string, c2: string): PairRecord {
  const subjects = [c1, c2].map((c) =>
    git(repo, "log", "-1", "--format=%s", c).trim(),
  ) as [string, string];
  const record = { c1, c2, subjects };
  const base = showFile(repo, `${c1}^`, path);
  if (base === undefined) {
    return { ...record, status: "no-base" };
  }
  const ours = showFile(repo, c1, path)!;
  // theirs = C2's own change, rebased onto C1^.
  const rebase = mergeFile(
    base,
    showFile(repo, `${c2}^`, path)!,
    showFile(repo, c2, path)!,
  );
  if (rebase.conflicts > 0) {
    return { ...record, status: "rebase-conflict" };
  }
  const theirs = rebase.text;
  const merged = mergeFile(ours, base, theirs);
  if (merged.conflicts > 0) {
    return { ...record, status: "semantic-conflict" };
  }
  // Imports always come from C2 so that only the replayed file differs
  // between the sides; otherwise dependency changes such as
  // `[packed = false]` on google.api.field_behavior leak into the bytes.
  let images: Parameters<typeof replayPair>[0];
  try {
    images = {
      base: build(c2, path, base),
      ours: build(c2, path, ours),
      theirs: build(c2, path, theirs),
      merged: build(c2, path, merged.text),
    };
  } catch (e) {
    return { ...record, status: "build-failure", error: String(e) };
  }
  const outcomes = replayPair(images, path);
  const baseDesc = embedded(images.base, path);
  const trivial =
    equalBytes(embedded(images.ours, path), baseDesc) ||
    equalBytes(embedded(images.theirs, path), baseDesc);
  return {
    ...record,
    status: "replayed",
    trivial,
    encodings: Object.fromEntries(
      ENCODINGS.map((e) => {
        const { merged: _, ...rest } = outcomes[e];
        return [e, rest];
      }),
    ) as Record<Encoding, Omit<EncodingOutcome, "merged">>,
  };
}

function summarize(records: PairRecord[]) {
  const replayed = records.filter((r) => r.status === "replayed");
  const count = (status: PairRecord["status"]) =>
    records.filter((r) => r.status === status).length;
  const perEncoding = (subset: typeof replayed) =>
    Object.fromEntries(
      ENCODINGS.map((e) => [
        e,
        {
          clean: subset.filter(
            (r) => r.encodings[e].conflicts === 0 && r.encodings[e].correct,
          ).length,
          conflict: subset.filter((r) => r.encodings[e].conflicts > 0).length,
          cleanButWrong: subset.filter(
            (r) => r.encodings[e].conflicts === 0 && !r.encodings[e].correct,
          ).length,
          fileConflict: subset.filter((r) => r.encodings[e].fileConflicts > 0)
            .length,
          fileCleanButWrong: subset.filter(
            (r) =>
              r.encodings[e].fileConflicts === 0 && !r.encodings[e].fileCorrect,
          ).length,
        },
      ]),
    ) as Record<
      Encoding,
      {
        clean: number;
        conflict: number;
        cleanButWrong: number;
        fileConflict: number;
        fileCleanButWrong: number;
      }
    >;
  return {
    pairs: records.length,
    noBase: count("no-base"),
    rebaseConflict: count("rebase-conflict"),
    semanticConflict: count("semantic-conflict"),
    buildFailure: count("build-failure"),
    replayed: replayed.length,
    trivial: replayed.filter((r) => r.trivial).length,
    all: perEncoding(replayed),
    nonTrivial: perEncoding(replayed.filter((r) => !r.trivial)),
  };
}

mkdirSync(resultsDir, { recursive: true });
const summaries: Record<string, ReturnType<typeof summarize>> = {};
const allRecords: PairRecord[] = [];
for (const path of TARGETS) {
  const commits = git(repo, "rev-list", GOOGLEAPIS_REV, "--", path)
    .trim()
    .split("\n")
    .slice(0, PAIRS + 1)
    .reverse();
  const records: PairRecord[] = [];
  for (let i = 0; i + 1 < commits.length; i++) {
    const record = replay(path, commits[i], commits[i + 1]);
    records.push(record);
    const detail =
      record.status === "replayed"
        ? ENCODINGS.map((e) => `${e}=${record.encodings[e].conflicts}`).join(
            " ",
          )
        : "";
    console.error(
      `${path} ${i + 1}/${commits.length - 1} ${record.status} ${detail}`,
    );
  }
  allRecords.push(...records);
  summaries[path] = summarize(records);
  writeFileSync(
    join(resultsDir, `${path.replaceAll("/", "_")}.json`),
    `${JSON.stringify({ path, rev: GOOGLEAPIS_REV, records }, null, 2)}\n`,
  );
}
summaries["total"] = summarize(allRecords);

const LABELS = { base64: "base64", a: "Option A", b: "Option B" } as const;
const label = (path: string) =>
  path === "total" ? "**total**" : `\`${path}\``;
const md = [
  "<!-- Generated by scripts/replay.ts -->",
  "",
  `googleapis@${GOOGLEAPIS_REV.slice(0, 12)}, the last ${PAIRS} consecutive commit pairs per file.`,
  "",
  "| file | pairs | C2 does not rebase onto C1^ | .proto conflicts | replayed | one side's descriptor unchanged |",
  "| --- | --- | --- | --- | --- | --- |",
  ...Object.entries(summaries).map(
    ([path, s]) =>
      `| ${label(path)} | ${s.pairs} | ${s.rebaseConflict + s.noBase} | ${s.semanticConflict} | ${s.replayed} | ${s.trivial} |`,
  ),
  "",
  "Replayed pairs where both sides changed the descriptor:",
  "",
  "| file | encoding | clean | conflict | clean but wrong | whole `_pb.ts`: conflict | whole `_pb.ts`: clean but wrong |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  ...Object.entries(summaries).flatMap(([path, s]) =>
    ENCODINGS.map((e) => {
      const c = s.nonTrivial[e];
      return `| ${label(path)} | ${LABELS[e]} | ${c.clean} | ${c.conflict} | ${c.cleanButWrong} | ${c.fileConflict} | ${c.fileCleanButWrong} |`;
    }),
  ),
];
writeFileSync(join(resultsDir, "summary.md"), `${md.join("\n")}\n`);
writeFileSync(
  join(resultsDir, "summary.json"),
  `${JSON.stringify({ rev: GOOGLEAPIS_REV, pairsPerFile: PAIRS, summaries }, null, 2)}\n`,
);
console.log(JSON.stringify(summaries["total"], null, 2));
