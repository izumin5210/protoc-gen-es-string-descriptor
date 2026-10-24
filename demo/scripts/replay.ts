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
import { generate, VARIANTS, type Variant } from "../src/generate.js";
import {
  cloneGoogleapis,
  GOOGLEAPIS_REV,
  git,
  materialize,
  showFile,
} from "../src/googleapis.js";
import { type MergeOutcome, replayPair } from "../src/replay-pair.js";
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
      variants: Record<Variant, RecordedOutcome>;
    }
);

type RecordedOutcome = Omit<MergeOutcome, "merged" | "fileMerged">;

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
    variants: Object.fromEntries(
      VARIANTS.map((v) => {
        const { merged: _, fileMerged: __, ...rest } = outcomes[v];
        return [v, rest];
      }),
    ) as Record<Variant, RecordedOutcome>,
  };
}

type Replayed = Extract<PairRecord, { status: "replayed" }>;

function perVariant(subset: Replayed[]) {
  return Object.fromEntries(
    VARIANTS.map((v) => {
      const of = (r: Replayed) => r.variants[v];
      const n = (pred: (o: RecordedOutcome) => boolean) =>
        subset.filter((r) => pred(of(r))).length;
      return [
        v,
        {
          clean: n((o) => o.conflicts === 0 && o.correct === true),
          conflict: n((o) => o.conflicts > 0),
          cleanButWrong: n((o) => o.conflicts === 0 && !o.correct),
          fileClean: n((o) => o.fileConflicts === 0 && o.fileCorrect === true),
          fileConflict: n((o) => o.fileConflicts > 0),
          fileCleanButWrong: n((o) => o.fileConflicts === 0 && !o.fileCorrect),
          // Wrong outside the descriptor, i.e. in messageDesc(file, N) & co.
          fileWrongOutsideDescriptor: n((o) => o.fileWrong?.rest === true),
        },
      ];
    }),
  ) as Record<
    Variant,
    Record<
      | "clean"
      | "conflict"
      | "cleanButWrong"
      | "fileClean"
      | "fileConflict"
      | "fileCleanButWrong"
      | "fileWrongOutsideDescriptor",
      number
    >
  >;
}

/** What adding the manifest did to the whole-file merges of A and B. */
function manifestEffect(subset: Replayed[]) {
  return Object.fromEntries(
    (["a", "b"] as const).map((e) => {
      const n = (
        pred: (without: RecordedOutcome, withM: RecordedOutcome) => boolean,
      ) =>
        subset.filter((r) => pred(r.variants[e], r.variants[`${e}-manifest`]))
          .length;
      return [
        e,
        {
          // Cost: a correct clean merge that now needs manual resolution.
          correctToConflict: n(
            (w, m) => !!w.fileCorrect && m.fileConflicts > 0,
          ),
          // Benefit: a silently wrong merge that now conflicts.
          wrongToConflict: n(
            (w, m) =>
              w.fileConflicts === 0 && !w.fileCorrect && m.fileConflicts > 0,
          ),
          stillWrong: n((_, m) => m.fileConflicts === 0 && !m.fileCorrect),
        },
      ];
    }),
  ) as Record<
    "a" | "b",
    { correctToConflict: number; wrongToConflict: number; stillWrong: number }
  >;
}

function summarize(records: PairRecord[]) {
  const replayed = records.filter(
    (r): r is Replayed => r.status === "replayed",
  );
  const nonTrivial = replayed.filter((r) => !r.trivial);
  const count = (status: PairRecord["status"]) =>
    records.filter((r) => r.status === status).length;
  return {
    pairs: records.length,
    noBase: count("no-base"),
    rebaseConflict: count("rebase-conflict"),
    semanticConflict: count("semantic-conflict"),
    buildFailure: count("build-failure"),
    replayed: replayed.length,
    trivial: replayed.length - nonTrivial.length,
    all: perVariant(replayed),
    nonTrivial: perVariant(nonTrivial),
    manifestEffect: manifestEffect(nonTrivial),
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
        ? VARIANTS.map(
            (v) =>
              `${v}=${record.variants[v].conflicts}/${record.variants[v].fileConflicts}`,
          ).join(" ")
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

const LABELS = {
  base64: "base64",
  a: "Option A",
  b: "Option B",
  "a-manifest": "Option A + manifest",
  "b-manifest": "Option B + manifest",
} as const;
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
  "Replayed pairs where both sides changed the descriptor. The manifest variants",
  "embed the same descriptor as A and B, so their `fileDesc(…)` columns match.",
  "",
  "| file | variant | `fileDesc(…)`: clean | conflict | clean but wrong | whole `_pb.ts`: clean | conflict | clean but wrong | of which outside the descriptor |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ...Object.entries(summaries).flatMap(([path, s]) =>
    VARIANTS.map((v) => {
      const c = s.nonTrivial[v];
      return `| ${label(path)} | ${LABELS[v]} | ${c.clean} | ${c.conflict} | ${c.cleanButWrong} | ${c.fileClean} | ${c.fileConflict} | ${c.fileCleanButWrong} | ${c.fileWrongOutsideDescriptor} |`;
    }),
  ),
  "",
  "What the manifest changes in whole-file merges (same pairs):",
  "",
  "| file | encoding | correct clean merge → conflict (cost) | wrong clean merge → conflict (benefit) | still clean but wrong |",
  "| --- | --- | --- | --- | --- |",
  ...Object.entries(summaries).flatMap(([path, s]) =>
    (["a", "b"] as const).map((e) => {
      const m = s.manifestEffect[e];
      return `| ${label(path)} | ${LABELS[e]} | ${m.correctToConflict} | ${m.wrongToConflict} | ${m.stillWrong} |`;
    }),
  ),
];
writeFileSync(join(resultsDir, "summary.md"), `${md.join("\n")}\n`);
writeFileSync(
  join(resultsDir, "summary.json"),
  `${JSON.stringify({ rev: GOOGLEAPIS_REV, pairsPerFile: PAIRS, summaries }, null, 2)}\n`,
);
console.log(JSON.stringify(summaries["total"], null, 2));
