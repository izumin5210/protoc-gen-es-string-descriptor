/**
 * Merge hand-written .proto edits and show what each descriptor encoding
 * produces under `git merge-file`.
 *
 * Usage: pnpm --filter demo conflict-demo
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, type DescMessage, toJsonString } from "@bufbuild/protobuf";
import { fileDesc } from "@bufbuild/protobuf/codegenv2";
import { nestedTypes } from "@bufbuild/protobuf/reflect";
import { base64Encode } from "@bufbuild/protobuf/wire";
import {
  decodeDescriptorExpr,
  extractDescriptorExpr,
} from "../src/descriptor-expr.js";
import {
  ENCODINGS,
  formatOf,
  generate,
  VARIANT_LABELS as LABELS,
  VARIANTS,
  type Variant,
} from "../src/generate.js";
import { protodescAvailable } from "../src/protodesc.js";
import { replayPair, type Side } from "../src/replay-pair.js";
import { bufBuild, diffText, mergeFile } from "../src/tools.js";

const PROTO_PATH = "example/v1/library.proto";
const demoDir = join(import.meta.dirname, "..", "conflict-demo");
const resultsDir = join(import.meta.dirname, "..", "results");

/** Build the scenario's proto, with the scenario's `deps/` next to it. */
function build(proto: string, scenario: string): Uint8Array {
  const root = mkdtempSync(join(tmpdir(), "conflict-demo-"));
  try {
    const deps = join(demoDir, scenario, "deps");
    if (existsSync(deps)) {
      cpSync(deps, root, { recursive: true });
    }
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

/**
 * What protobuf-es makes of an embedded descriptor: every message with its
 * fields and oneofs, as one line each.
 */
function runtimeView(embedded: Uint8Array): string[] {
  try {
    const file = fileDesc(base64Encode(embedded, "std_raw"));
    return [...nestedTypes(file)].map((desc) => {
      switch (desc.kind) {
        case "message":
          return `message ${JSON.stringify(desc.typeName)} { ${desc.fields
            .map(
              (f) =>
                `${f.name} = ${f.number}${f.oneof ? ` (oneof ${f.oneof.name})` : ""}`,
            )
            .join("; ")} }`;
        case "enum":
          return `enum ${JSON.stringify(desc.typeName)} { ${desc.values.map((v) => `${v.name} = ${v.number}`).join("; ")} }`;
        default:
          return `${desc.kind} ${desc.typeName}`;
      }
    });
  } catch (e) {
    return [`fails to load: ${e}`];
  }
}

interface Probe {
  /** Position of the message, as generated code passes it to messageDesc. */
  path: number[];
  init: Record<string, unknown>;
}

/**
 * Serialize a message created from the scenario's probe to JSON, looking the
 * message up by position like `messageDesc(file, ...path)` does.
 */
function probeJson(embedded: Uint8Array, probe: Probe): string {
  try {
    const file = fileDesc(base64Encode(embedded, "std_raw"));
    let message: DescMessage | undefined = file.messages[probe.path[0]];
    for (const i of probe.path.slice(1)) {
      message = message?.nestedMessages[i];
    }
    if (message === undefined) {
      return `no message at ${probe.path.join(".")}`;
    }
    return toJsonString(message, create(message, probe.init as never));
  } catch (e) {
    return `fails: ${e}`;
  }
}

const sharedBase = readFileSync(join(demoDir, "base.proto"), "utf8");
const scenarios = [
  "same-service-different-rpcs",
  "same-message-different-fields",
  "message-inserted-next-to-changed-message",
  "control-different-messages",
  "index-shift-insert-vs-append",
  "oneof-index-insert-vs-append",
  "oneof-index-insert-vs-append-separated",
  "same-size-field-edits",
  "public-import-vs-inserted-import",
];

const report: string[] = [];
const summary: Record<string, Record<string, string>> = {};
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
    base: build(base, scenario),
    ours: build(ours, scenario),
    theirs: build(theirs, scenario),
    merged: build(protoMerge.text, scenario),
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
    summary[scenario][encoding] =
      outcome.conflicts > 0
        ? "conflict"
        : outcome.correct
          ? "clean"
          : "**clean but wrong**";
    if (outcome.conflicts === 0 && !outcome.correct) {
      report.push(
        `- **${LABELS[encoding]}**: clean, but decodes to a different descriptor than the merged .proto's (see below)`,
      );
      continue;
    }
    if (outcome.conflicts === 0) {
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
  const probeFile = join(demoDir, scenario, "probe.json");
  const probe: Probe | undefined = existsSync(probeFile)
    ? JSON.parse(readFileSync(probeFile, "utf8"))
    : undefined;
  const details: string[] = [];
  for (const variant of VARIANTS) {
    const outcome = outcomes[variant];
    if (outcome.fileConflicts > 0) {
      fileSummary[scenario][variant] = "conflict";
      const hunks = manifestHunks(outcome.fileMerged);
      if (variant.includes("manifest") && hunks !== "") {
        details.push(
          `- **${LABELS[variant]}**: conflicts in the manifest`,
          "",
          "  ```js",
          ...indent(hunks),
          "  ```",
        );
      }
      continue;
    }
    if (outcome.verdict === "correct") {
      fileSummary[scenario][variant] = "clean";
      continue;
    }
    if (outcome.verdict === "error") {
      fileSummary[scenario][variant] = "error";
      details.push(
        `- **${LABELS[variant]}**: clean, but fails: \`${outcome.verdictDetail}\``,
      );
      continue;
    }
    const inDescriptor = outcome.fileWrong?.descriptor === true;
    const verdict =
      outcome.protodesc === undefined
        ? ""
        : outcome.protodesc === "ok"
          ? "; protobuf-go accepts it"
          : "; protobuf-go rejects it";
    fileSummary[scenario][variant] =
      `**clean but wrong** (${inDescriptor ? "descriptor" : "generated code"}${verdict})`;
    details.push(
      `- **${LABELS[variant]}**: clean, but differs from the file generated from the merged .proto (\`-\` expected, \`+\` merged)`,
      "",
      "  ```diff",
      ...indent(diffText(expected(variant), outcome.fileMerged, 0)),
      "  ```",
    );
    if (!inDescriptor) {
      continue;
    }
    const encoding = formatOf(variant);
    const merged = decodeDescriptorExpr(
      extractDescriptorExpr(outcome.fileMerged),
      encoding,
    );
    const want = decodeDescriptorExpr(
      extractDescriptorExpr(expected(variant)),
      encoding,
    );
    details.push(
      "",
      "  protobuf-es loads the merged descriptor as (`-` expected, `+` merged):",
      "",
      "  ```diff",
      ...indent(
        diffText(
          `${runtimeView(want).join("\n")}\n`,
          `${runtimeView(merged).join("\n")}\n`,
          0,
        ) || " (no difference)",
      ),
      "  ```",
    );
    if (probe !== undefined) {
      details.push(
        "",
        `  \`toJsonString(create(messageDesc(file, ${probe.path.join(", ")}), ${JSON.stringify(probe.init)}))\`: expected \`${probeJson(want, probe)}\`, merged \`${probeJson(merged, probe)}\``,
      );
    }
    if (outcome.protodesc !== undefined) {
      details.push(
        "",
        `  protobuf-go \`protodesc.NewFiles\`: \`${outcome.protodesc}\``,
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
    (s) => `| ${s} | ${ENCODINGS.map((e) => summary[s][e]).join(" | ")} |`,
  ),
  "",
  `Whole generated \`_pb.ts\`, compared with the file generated from the merged .proto${protodescAvailable() ? "; wrong descriptors are also loaded with protobuf-go's `protodesc.NewFiles`" : ""}:`,
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
