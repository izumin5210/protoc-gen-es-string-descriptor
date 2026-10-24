/**
 * Merge hand-written .proto edits and show what each descriptor encoding
 * produces under `git merge-file`.
 *
 * Usage: pnpm --filter demo conflict-demo
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractDescriptorExpr } from "../src/descriptor-expr.js";
import {
  ENCODINGS,
  generate,
  VARIANTS,
  type Variant,
} from "../src/generate.js";
import { replayPair, type Side } from "../src/replay-pair.js";
import { bufBuild, diffText, mergeFile } from "../src/tools.js";

const PROTO_PATH = "example/v1/library.proto";
const demoDir = join(import.meta.dirname, "..", "conflict-demo");
const resultsDir = join(import.meta.dirname, "..", "results");

const LABELS = {
  base64: "base64",
  a: "Option A",
  b: "Option B",
  "a-manifest": "Option A + manifest",
  "b-manifest": "Option B + manifest",
} as const;

function build(proto: string): Uint8Array {
  const root = mkdtempSync(join(tmpdir(), "conflict-demo-"));
  try {
    mkdirSync(join(root, "example/v1"), { recursive: true });
    writeFileSync(join(root, PROTO_PATH), proto);
    return bufBuild(root, PROTO_PATH);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function conflictHunks(text: string): string {
  return [...text.matchAll(/^<<<<<<< [\s\S]*?^>>>>>>> .*$/gm)]
    .map((m) => m[0])
    .join("\n...\n")
    .replace(/^(.{72}).{8,}$/gm, "$1…");
}

function indent(text: string): string[] {
  return text.split("\n").map((line) => `  ${line}`);
}

/** Hunks that touch the index manifest, i.e. the ones it adds. */
function manifestHunks(text: string): string {
  return [...text.matchAll(/^<<<<<<< [\s\S]*?^>>>>>>> .*$/gm)]
    .map((m) => m[0])
    .filter((hunk) => /^\/\/ [\d.]+: /m.test(hunk))
    .join("\n...\n");
}

const sharedBase = readFileSync(join(demoDir, "base.proto"), "utf8");
const scenarios = [
  "same-service-different-rpcs",
  "same-message-different-fields",
  "message-inserted-next-to-changed-message",
  "control-different-messages",
  "index-shift-insert-vs-append",
];

const report: string[] = [];
const summary: Record<string, Record<string, number>> = {};
const fileSummary: Record<string, Record<string, string>> = {};
for (const scenario of scenarios) {
  const baseFile = join(demoDir, scenario, "base.proto");
  const base = existsSync(baseFile)
    ? readFileSync(baseFile, "utf8")
    : sharedBase;
  const ours = readFileSync(join(demoDir, scenario, "ours.proto"), "utf8");
  const theirs = readFileSync(join(demoDir, scenario, "theirs.proto"), "utf8");
  const protoMerge = mergeFile(ours, base, theirs);
  if (protoMerge.conflicts > 0) {
    throw new Error(`${scenario}: the .proto itself conflicts`);
  }
  const images: Record<Side, Uint8Array> = {
    base: build(base),
    ours: build(ours),
    theirs: build(theirs),
    merged: build(protoMerge.text),
  };
  const outcomes = replayPair(images, PROTO_PATH);
  const optionB = (image: Uint8Array) =>
    extractDescriptorExpr(generate(image, [PROTO_PATH])[0].content.b);
  summary[scenario] = {};

  report.push(`### ${scenario}`, "");
  report.push(
    "```diff",
    `# ours`,
    diffText(base, ours),
    `# theirs`,
    diffText(base, theirs),
    "```",
    "",
  );
  for (const encoding of ENCODINGS) {
    const outcome = outcomes[encoding];
    summary[scenario][encoding] = outcome.conflicts;
    if (outcome.conflicts === 0) {
      if (!outcome.correct) {
        throw new Error(`${scenario}/${encoding}: clean merge decodes wrong`);
      }
      report.push(
        `- **${LABELS[encoding]}**: clean, decodes to the descriptor of the merged .proto`,
      );
      if (encoding === "b") {
        const baseB = optionB(images.base);
        report.push(
          "",
          "  ```diff",
          "  # ours",
          ...indent(diffText(baseB, optionB(images.ours))),
          "  # theirs",
          ...indent(diffText(baseB, optionB(images.theirs))),
          "  ```",
        );
      }
      continue;
    }
    report.push(
      `- **${LABELS[encoding]}**: ${outcome.conflicts} conflict(s)`,
      "",
    );
    report.push("  ```js", ...indent(conflictHunks(outcome.merged)), "  ```");
  }

  fileSummary[scenario] = {};
  const expected = (variant: Variant) =>
    generate(images.merged, [PROTO_PATH])[0].content[variant];
  const details: string[] = [];
  for (const variant of VARIANTS) {
    const outcome = outcomes[variant];
    if (outcome.fileConflicts > 0) {
      fileSummary[scenario][variant] = `${outcome.fileConflicts} conflict(s)`;
      const hunks = manifestHunks(outcome.fileMerged);
      if (variant.endsWith("-manifest") && hunks !== "") {
        details.push(
          `- **${LABELS[variant]}**: conflicts in the manifest`,
          "",
          "  ```js",
          ...indent(hunks),
          "  ```",
        );
      }
    } else if (outcome.fileCorrect) {
      fileSummary[scenario][variant] = "clean";
    } else {
      fileSummary[scenario][variant] = "**clean but wrong**";
      details.push(
        `- **${LABELS[variant]}**: clean, but differs from the file generated from the merged .proto (\`-\` expected, \`+\` merged)`,
        "",
        "  ```diff",
        ...indent(diffText(expected(variant), outcome.fileMerged, 0)),
        "  ```",
      );
    }
  }
  if (details.length > 0) {
    report.push("", "Whole `_pb.ts`:", "", ...details);
  }
  report.push("");
}

const table = [
  "`fileDesc(…)` alone:",
  "",
  `| scenario | ${ENCODINGS.map((e) => LABELS[e]).join(" | ")} |`,
  `| --- | ${ENCODINGS.map(() => "---").join(" | ")} |`,
  ...scenarios.map(
    (s) =>
      `| ${s} | ${ENCODINGS.map((e) => (summary[s][e] === 0 ? "clean" : `${summary[s][e]} conflict(s)`)).join(" | ")} |`,
  ),
  "",
  "Whole generated `_pb.ts`, compared with the file generated from the merged .proto:",
  "",
  `| scenario | ${VARIANTS.map((v) => LABELS[v]).join(" | ")} |`,
  `| --- | ${VARIANTS.map(() => "---").join(" | ")} |`,
  ...scenarios.map(
    (s) => `| ${s} | ${VARIANTS.map((v) => fileSummary[s][v]).join(" | ")} |`,
  ),
];

mkdirSync(resultsDir, { recursive: true });
writeFileSync(
  join(resultsDir, "conflict-demo.md"),
  `${["<!-- Generated by scripts/conflict-demo.ts -->", "", ...table, "", ...report].join("\n").trimEnd()}\n`,
);
console.log(table.join("\n"));
