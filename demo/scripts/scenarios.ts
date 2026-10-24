/**
 * Run the scenario catalogue: minimal pairs of concurrent edits whose
 * `.proto` merges cleanly, judged per variant as a user would see them.
 *
 * Usage: pnpm --filter demo scenarios
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VARIANT_LABELS, VARIANTS, type Variant } from "../src/generate.js";
import { replayPair, type Verdict } from "../src/replay-pair.js";
import { bufBuild, diffText, mergeFile } from "../src/tools.js";

const PROTO_PATH = "m.proto";
const scenariosDir = join(import.meta.dirname, "..", "scenarios");
const resultsDir = join(import.meta.dirname, "..", "results");

const DESCRIPTIONS: Record<string, string> = {
  "01-index-shift":
    "One side inserts a message in the middle; the other appends one",
  "02-both-add-enums": "Both sides add top-level enums at different positions",
  "03-optional-adjacent":
    "Both sides add `optional` fields to one message (adjacent)",
  "04-optional-separated":
    "Both sides add `optional` fields to one message (a plain field in between)",
  "05-optional-both-append":
    "Both sides add `optional` fields to one message (far apart)",
  "06-same-size": "Both sides add same-size fields to one message (far apart)",
  "07-dup-field-number": "Both sides add a field with the same number",
  "08-dup-enum-number": "Both sides add an enum value with the same number",
  "09-dup-field-name": "Both sides add a field with the same name",
  "10-rename-vs-ref":
    "One side renames a message; the other references the old name",
  "11-dup-message-name": "Both sides add a message with the same name",
  "12-public-import":
    "One side makes an import public; the other inserts an import before it",
  "13-real-oneof-shift":
    "One side inserts a oneof before an existing one; the other adds a member to the existing one",
  "14-fields-separated": "Both sides add fields to one message (far apart)",
  "15-rpcs-separated": "Both sides add RPCs to one service (far apart)",
  "16-nested-different-parents":
    "Both sides add nested messages to different parents",
  "17-map-vs-nested":
    "One side adds a map field; the other adds a nested message to the same message",
  "18-imports-separated": "Both sides add different imports",
  "19-oneof-members-in-two-messages":
    "Both sides add a member to the oneof of neighbouring messages",
};

const SYMBOLS: Record<Verdict, string> = {
  correct: "✅ correct",
  conflict: "⚪ conflict",
  error: "⚠️ error",
  wrong: "❌ **silently wrong**",
};

/** Build `m.proto` with the scenario's `deps/` next to it. */
function build(dir: string, proto: string): Uint8Array {
  const root = mkdtempSync(join(tmpdir(), "scenario-"));
  try {
    if (existsSync(join(dir, "deps"))) {
      cpSync(join(dir, "deps"), root, { recursive: true });
    }
    writeFileSync(join(root, PROTO_PATH), proto);
    return bufBuild(root, PROTO_PATH);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

interface ScenarioResult {
  scenario: string;
  /** Why the merged `.proto` does not compile, if it does not. */
  invalid?: string;
  verdicts: Record<Variant, Verdict>;
  details: Partial<Record<Variant, string>>;
}

const results: ScenarioResult[] = [];
const report: string[] = [];
for (const scenario of readdirSync(scenariosDir).sort()) {
  const dir = join(scenariosDir, scenario);
  const read = (side: string) =>
    readFileSync(join(dir, `${side}.proto`), "utf8");
  const [base, ours, theirs] = ["base", "ours", "theirs"].map(read);
  const protoMerge = mergeFile(ours, base, theirs);
  if (protoMerge.conflicts > 0) {
    throw new Error(`${scenario}: the .proto itself conflicts`);
  }
  let merged: Uint8Array | undefined;
  let invalid: string | undefined;
  try {
    merged = build(dir, protoMerge.text);
  } catch (e) {
    invalid = String(e)
      .split("\n")
      .find((line) => line.includes(PROTO_PATH))
      ?.replace(/^.*?m\.proto:[\d:]*\s*/, "");
  }
  const outcomes = replayPair(
    {
      base: build(dir, base),
      ours: build(dir, ours),
      theirs: build(dir, theirs),
      merged,
    },
    PROTO_PATH,
  );
  const result: ScenarioResult = {
    scenario,
    ...(invalid === undefined ? {} : { invalid }),
    verdicts: {} as Record<Variant, Verdict>,
    details: {},
  };
  report.push(
    `### ${scenario}`,
    "",
    DESCRIPTIONS[scenario] ?? "",
    "",
    "```diff",
    "# ours",
    diffText(base, ours),
    "# theirs",
    diffText(base, theirs),
    "```",
    "",
  );
  if (invalid !== undefined) {
    report.push(`The merged \`.proto\` does not compile: ${invalid}`, "");
  }
  for (const variant of VARIANTS) {
    const { verdict, verdictDetail } = outcomes[variant];
    result.verdicts[variant] = verdict;
    if (verdictDetail !== undefined) {
      result.details[variant] = verdictDetail;
    }
    report.push(
      `- ${VARIANT_LABELS[variant]}: ${SYMBOLS[verdict]}${verdictDetail === undefined ? "" : ` (${verdictDetail.replace(/\s+/g, " ").slice(0, 160)})`}`,
    );
  }
  report.push("");
  results.push(result);
}

const row = (cells: string[]) => `| ${cells.join(" | ")} |`;
const table = [
  row(["Scenario", ...VARIANTS.map((v) => VARIANT_LABELS[v])]),
  row(["---", ...VARIANTS.map(() => "---")]),
];
for (const valid of [true, false]) {
  table.push(
    row([
      valid
        ? "***Merged `.proto` is valid (ideal: correct)***"
        : "***Merged `.proto` is invalid (ideal: conflict or error)***",
      ...VARIANTS.map(() => ""),
    ]),
  );
  for (const r of results.filter((r) => (r.invalid === undefined) === valid)) {
    table.push(
      row([
        DESCRIPTIONS[r.scenario] ?? r.scenario,
        ...VARIANTS.map((v) => SYMBOLS[r.verdicts[v]]),
      ]),
    );
  }
}

mkdirSync(resultsDir, { recursive: true });
writeFileSync(
  join(resultsDir, "scenarios.md"),
  `${[
    "<!-- Generated by scripts/scenarios.ts -->",
    "",
    "- *error*: TypeScript reports an error, or loading the descriptor throws.",
    "- *silently wrong*: no error, but the result differs from the file generated from the merged `.proto`.",
    "",
    ...table,
    "",
    ...report,
  ]
    .join("\n")
    .trimEnd()}\n`,
);
writeFileSync(
  join(resultsDir, "scenarios.json"),
  `${JSON.stringify(results, null, 2)}\n`,
);
console.log(table.join("\n"));
