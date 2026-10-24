/**
 * Replay consecutive commit pairs of frequently edited googleapis files as if
 * they had been made concurrently, and merge the generated descriptors.
 *
 * Usage: pnpm --filter demo replay [set, default "default"] [pairs per file, default 40]
 *
 * Sets: "default" (results/replay/) and "aiplatform"
 * (results/replay-aiplatform/).
 */
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { equalBytes } from "../src/bytes.js";
import {
  decodeDescriptorExpr,
  extractDescriptorExpr,
} from "../src/descriptor-expr.js";
import {
  generate,
  VARIANT_LABELS,
  VARIANTS,
  type Variant,
} from "../src/generate.js";
import {
  cloneGoogleapis,
  GOOGLEAPIS_REV,
  git,
  materialize,
  showFile,
} from "../src/googleapis.js";
import { protodescAvailable } from "../src/protodesc.js";
import { type MergeOutcome, replayPair } from "../src/replay-pair.js";
import { bufBuild, mergeFile } from "../src/tools.js";

const SETS: Record<string, { dir: string; targets: string[] }> = {
  default: {
    dir: "replay",
    targets: [
      "google/container/v1/cluster_service.proto",
      "google/pubsub/v1/pubsub.proto",
      "google/cloud/deploy/v1/cloud_deploy.proto",
    ],
  },
  aiplatform: {
    dir: "replay-aiplatform",
    targets: [
      "google/cloud/aiplatform/v1/prediction_service.proto",
      "google/cloud/aiplatform/v1/content.proto",
      "google/cloud/aiplatform/v1/tool.proto",
    ],
  },
};
const SET = SETS[process.argv[2] ?? "default"];
if (SET === undefined) {
  throw new Error(`unknown set ${process.argv[2]}`);
}
const PAIRS = Number(process.argv[3] ?? 40);
const resultsDir = join(import.meta.dirname, "..", "results", SET.dir);

type PairRecord = {
  c1: string;
  c2: string;
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
  const record = { c1, c2 };
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
          // Wrong descriptors that protobuf-go loads without complaint.
          wrongDescriptorGoAccepts: n((o) => o.protodesc === "ok"),
          correct: n((o) => o.verdict === "correct"),
          equivalent: n((o) => o.verdictDetail === "equivalent"),
          wrong: n((o) => o.verdict === "wrong"),
          error: n((o) => o.verdict === "error"),
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
      | "fileWrongOutsideDescriptor"
      | "wrongDescriptorGoAccepts"
      | "correct"
      | "equivalent"
      | "wrong"
      | "error",
      number
    >
  >;
}

const MANIFEST_PAIRS = [
  ["a", "a-manifest"],
  ["b", "b-index-manifest"],
  ["b", "b-manifest"],
] as const;

/** What adding a manifest did to the whole-file merges. */
function manifestEffect(subset: Replayed[]) {
  return MANIFEST_PAIRS.map(([without, withM]) => {
    const n = (
      pred: (without: RecordedOutcome, withM: RecordedOutcome) => boolean,
    ) =>
      subset.filter((r) => pred(r.variants[without], r.variants[withM])).length;
    return {
      without,
      with: withM,
      // Cost: a correct clean merge that now needs manual resolution.
      correctToConflict: n((w, m) => !!w.fileCorrect && m.fileConflicts > 0),
      // Benefit: a silently wrong merge that now conflicts.
      wrongToConflict: n(
        (w, m) =>
          w.fileConflicts === 0 && !w.fileCorrect && m.fileConflicts > 0,
      ),
      stillWrong: n((_, m) => m.fileConflicts === 0 && !m.fileCorrect),
    };
  });
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

/** One TSV row per pair: `fileDesc(…)` alone / whole file per variant. */
function row(path: string, r: PairRecord): string {
  const cells =
    r.status === "replayed"
      ? VARIANTS.map((v) => {
          const o = r.variants[v];
          const expr =
            o.conflicts > 0 ? "conflict" : o.correct ? "clean" : "wrong";
          const go =
            o.protodesc === undefined
              ? ""
              : o.protodesc === "ok"
                ? " (Go accepts)"
                : " (Go rejects)";
          // A correct merge that is not byte-identical to the regenerated file.
          const equivalent =
            o.verdictDetail === "equivalent" ? " (equivalent)" : "";
          return `${expr}/${o.verdict}${equivalent}${go}`;
        })
      : VARIANTS.map(() => "");
  const status =
    r.status === "replayed" && r.trivial
      ? "replayed, one side unchanged"
      : r.status;
  return [path, r.c1.slice(0, 12), r.c2.slice(0, 12), status, ...cells].join(
    "\t",
  );
}

rmSync(resultsDir, { recursive: true, force: true });
mkdirSync(resultsDir, { recursive: true });
const summaries: Record<string, ReturnType<typeof summarize>> = {};
const allRecords: PairRecord[] = [];
const rows = [["file", "C1", "C2", "status", ...VARIANTS].join("\t")];
for (const path of SET.targets) {
  const commits = git(repo, "rev-list", GOOGLEAPIS_REV, "--", path)
    .trim()
    .split("\n")
    .slice(0, PAIRS + 1)
    .reverse();
  const records: PairRecord[] = [];
  for (let i = 0; i + 1 < commits.length; i++) {
    const record = replay(path, commits[i], commits[i + 1]);
    records.push(record);
    rows.push(row(path, record));
    console.error(`${path} ${i + 1}/${commits.length - 1} ${rows.at(-1)}`);
  }
  allRecords.push(...records);
  summaries[path] = summarize(records);
}
summaries["total"] = summarize(allRecords);
writeFileSync(join(resultsDir, "pairs.tsv"), `${rows.join("\n")}\n`);

const label = (path: string) =>
  path === "total" ? "**total**" : `\`${path}\``;
const md = [
  "<!-- Generated by scripts/replay.ts -->",
  "",
  `googleapis@${GOOGLEAPIS_REV.slice(0, 12)}, the last ${PAIRS} consecutive commit pairs per file. Per-pair results: [\`pairs.tsv\`](pairs.tsv), as \`fileDesc(…)\` alone / whole file.`,
  "",
  "| file | pairs | C2 does not rebase onto C1^ | .proto conflicts | build failures | replayed | one side's descriptor unchanged |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  ...Object.entries(summaries).map(
    ([path, s]) =>
      `| ${label(path)} | ${s.pairs} | ${s.rebaseConflict + s.noBase} | ${s.semanticConflict} | ${s.buildFailure} | ${s.replayed} | ${s.trivial} |`,
  ),
  "",
  "Whole `_pb.ts`, all replayed pairs. *Error* means that the TypeScript",
  "compiler or loading the descriptor fails; *silently wrong* means neither",
  "does, but the result differs from the file generated from the merged",
  "`.proto`.",
  "",
  "| file | variant | correct | of which not byte-identical | conflict | silently wrong | error |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  ...Object.entries(summaries).flatMap(([path, s]) =>
    VARIANTS.map((v) => {
      const c = s.all[v];
      return `| ${label(path)} | ${VARIANT_LABELS[v]} | ${c.correct} | ${c.equivalent} | ${c.fileConflict} | ${c.wrong} | ${c.error} |`;
    }),
  ),
  "",
  "Replayed pairs where both sides changed the descriptor. Variants that embed",
  "the same descriptor have the same `fileDesc(…)` columns.",
  "",
  "| file | variant | `fileDesc(…)`: clean | conflict | clean but wrong | whole `_pb.ts`: clean | conflict | clean but wrong | of which outside the descriptor | wrong descriptors protobuf-go accepts |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ...Object.entries(summaries).flatMap(([path, s]) =>
    VARIANTS.map((v) => {
      const c = s.nonTrivial[v];
      return `| ${label(path)} | ${VARIANT_LABELS[v]} | ${c.clean} | ${c.conflict} | ${c.cleanButWrong} | ${c.fileClean} | ${c.fileConflict} | ${c.fileCleanButWrong} | ${c.fileWrongOutsideDescriptor} | ${protodescAvailable() ? c.wrongDescriptorGoAccepts : "—"} |`;
    }),
  ),
  ...(protodescAvailable()
    ? []
    : [
        "",
        "Go was not available, so wrong descriptors were not loaded with protobuf-go.",
      ]),
  "",
  "What the manifest changes in whole-file merges (same pairs):",
  "",
  "| file | without → with | correct clean merge → conflict (cost) | wrong clean merge → conflict (benefit) | still clean but wrong |",
  "| --- | --- | --- | --- | --- |",
  ...Object.entries(summaries).flatMap(([path, s]) =>
    s.manifestEffect.map(
      (m) =>
        `| ${label(path)} | ${VARIANT_LABELS[m.without]} → ${VARIANT_LABELS[m.with]} | ${m.correctToConflict} | ${m.wrongToConflict} | ${m.stillWrong} |`,
    ),
  ),
];
writeFileSync(join(resultsDir, "summary.md"), `${md.join("\n")}\n`);
writeFileSync(
  join(resultsDir, "summary.json"),
  `${JSON.stringify({ rev: GOOGLEAPIS_REV, pairsPerFile: PAIRS, total: summaries["total"] }, null, 2)}\n`,
);
console.log(md.join("\n"));
