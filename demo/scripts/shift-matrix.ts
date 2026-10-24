/**
 * Apply every pair of insert/delete edits to every list that generated code
 * indexes into (top-level and nested messages, enums and extensions, and
 * services), merge the generated `_pb.ts` with and without the index
 * manifest, and compare with the file generated from the merged schema.
 *
 * Usage: pnpm --filter demo shift-matrix
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
  type DescriptorProtoSchema,
  type EnumDescriptorProtoSchema,
  FieldDescriptorProto_Label,
  FieldDescriptorProto_Type,
  type FieldDescriptorProtoSchema,
  type FileDescriptorProto,
  FileDescriptorProtoSchema,
  file_google_protobuf_descriptor,
} from "@bufbuild/protobuf/wkt";
import { generateFromProtos, VARIANTS, type Variant } from "../src/generate.js";
import { mergeGenerated, type Side } from "../src/replay-pair.js";
import { mergeFile } from "../src/tools.js";

const resultsDir = join(import.meta.dirname, "..", "results");
const FILE = "shift.proto";

/** A schema reduced to the lists whose positions generated code uses. */
interface Schema {
  messages: string[];
  nestedMessages: string[];
  enums: string[];
  nestedEnums: string[];
  services: string[];
  extensions: string[];
  nestedExtensions: string[];
}

type List = keyof Schema;

const LISTS: Record<List, string> = {
  messages: "message",
  nestedMessages: "nested message",
  enums: "enum",
  nestedEnums: "nested enum",
  services: "service",
  extensions: "extension",
  nestedExtensions: "nested extension",
};

// The nested lists live in the second top-level message, so that inserting
// or deleting around it renumbers their paths too.
const PARENT = "B";

const BASE: Schema = {
  messages: ["A", PARENT, "C"],
  nestedMessages: ["B1", "B2", "B3"],
  enums: ["E1", "E2", "E3"],
  nestedEnums: ["BE1", "BE2", "BE3"],
  services: ["S1", "S2", "S3"],
  extensions: ["x1", "x2", "x3"],
  nestedExtensions: ["bx1", "bx2", "bx3"],
};

type Op =
  | "insert front"
  | "insert middle"
  | "append"
  | "delete first"
  | "delete last";
const OPS: Op[] = [
  "insert front",
  "insert middle",
  "append",
  "delete first",
  "delete last",
];

interface Edit {
  list: List;
  op: Op;
}

/** Edits are anchored on base elements, so both sides compose. */
function apply(schema: Schema, edit: Edit, side: "ours" | "theirs"): Schema {
  const base = BASE[edit.list];
  const items = [...schema[edit.list]];
  const added = newName(edit.list, side);
  const before = (anchor: string) => {
    const i = items.indexOf(anchor);
    if (i < 0) {
      throw new Error(`anchor ${anchor} is gone`);
    }
    items.splice(i, 0, added);
  };
  switch (edit.op) {
    case "insert front":
      before(base[0]);
      break;
    case "insert middle":
      before(base[1]);
      break;
    case "append":
      items.push(added);
      break;
    case "delete first":
    case "delete last": {
      const name = edit.op === "delete first" ? base[0] : base[base.length - 1];
      if (name === PARENT) {
        throw new Error("the parent of the nested lists is never deleted");
      }
      items.splice(items.indexOf(name), 1);
      break;
    }
  }
  return { ...schema, [edit.list]: items };
}

const NEW_NAMES: Record<List, string> = {
  messages: "M",
  nestedMessages: "Nm",
  enums: "En",
  nestedEnums: "Ne",
  services: "Svc",
  extensions: "x",
  nestedExtensions: "nx",
};

function newName(list: List, side: "ours" | "theirs"): string {
  return list.toLowerCase().includes("extension")
    ? `${NEW_NAMES[list]}_${side}`
    : `${NEW_NAMES[list]}${side[0].toUpperCase()}${side.slice(1)}`;
}

const extensionNumbers = new Map<string, number>();
function extensionNumber(name: string): number {
  let n = extensionNumbers.get(name);
  if (n === undefined) {
    n = 50001 + extensionNumbers.size;
    extensionNumbers.set(name, n);
  }
  return n;
}

function extension(
  name: string,
): MessageInitShape<typeof FieldDescriptorProtoSchema> {
  return {
    name,
    number: extensionNumber(name),
    label: FieldDescriptorProto_Label.OPTIONAL,
    type: FieldDescriptorProto_Type.STRING,
    extendee: ".google.protobuf.MessageOptions",
    jsonName: name,
  };
}

function enumType(
  name: string,
): MessageInitShape<typeof EnumDescriptorProtoSchema> {
  return {
    name,
    value: [{ name: `${name.toUpperCase()}_UNSPECIFIED`, number: 0 }],
  };
}

function toProto(schema: Schema): FileDescriptorProto {
  return create(FileDescriptorProtoSchema, {
    name: FILE,
    package: "shift.v1",
    syntax: "proto3",
    dependency: ["google/protobuf/descriptor.proto"],
    messageType: schema.messages.map(
      (name): MessageInitShape<typeof DescriptorProtoSchema> =>
        name === PARENT
          ? {
              name,
              nestedType: schema.nestedMessages.map((n) => ({ name: n })),
              enumType: schema.nestedEnums.map(enumType),
              extension: schema.nestedExtensions.map(extension),
            }
          : { name },
    ),
    enumType: schema.enums.map(enumType),
    service: schema.services.map((name) => ({ name })),
    extension: schema.extensions.map(extension),
  });
}

/**
 * The same schema as .proto text, one block per element with blank lines in
 * between, to tell whether the edits would merge cleanly as .proto at all.
 */
function toText(schema: Schema): string {
  const ext = (name: string, pad: string) =>
    `${pad}extend google.protobuf.MessageOptions {\n${pad}  string ${name} = ${extensionNumber(name)};\n${pad}}\n`;
  const en = (name: string, pad: string) =>
    `${pad}enum ${name} {\n${pad}  ${name.toUpperCase()}_UNSPECIFIED = 0;\n${pad}}\n`;
  const blocks = [
    'syntax = "proto3";\n\npackage shift.v1;\n\nimport "google/protobuf/descriptor.proto";\n',
    ...schema.messages.map((name) =>
      name === PARENT
        ? [
            `message ${name} {\n`,
            ...schema.nestedMessages.map((n) => `  message ${n} {\n  }\n`),
            ...schema.nestedEnums.map((n) => en(n, "  ")),
            ...schema.nestedExtensions.map((n) => ext(n, "  ")),
            "}\n",
          ].join("\n")
        : `message ${name} {\n}\n`,
    ),
    ...schema.enums.map((n) => en(n, "")),
    ...schema.services.map((n) => `service ${n} {\n}\n`),
    ...schema.extensions.map((n) => ext(n, "")),
  ];
  return blocks.join("\n");
}

const descriptorProto = file_google_protobuf_descriptor.proto;
function generate(schema: Schema): Record<Variant, string> {
  const [file] = generateFromProtos([descriptorProto, toProto(schema)], [FILE]);
  return file.content;
}

type Outcome = "clean" | "conflict" | "clean but wrong";
interface Case {
  ours: Edit;
  theirs: Edit;
  sameList: boolean;
  status: "replayed" | "proto conflict";
  outcomes?: Record<Variant, Outcome>;
}

const edits = (Object.keys(LISTS) as List[]).flatMap((list) =>
  OPS.map((op) => ({ list, op })),
);
const baseText = toText(BASE);
const cases: Case[] = [];
for (const ours of edits) {
  for (const theirs of edits) {
    const sameList = ours.list === theirs.list;
    const oursSchema = apply(BASE, ours, "ours");
    const theirsSchema = apply(BASE, theirs, "theirs");
    let mergedSchema: Schema | undefined;
    try {
      mergedSchema = apply(oursSchema, theirs, "theirs");
    } catch {
      // The other side deleted the anchor.
    }
    const protoMerge = mergeFile(
      toText(oursSchema),
      baseText,
      toText(theirsSchema),
    );
    if (
      mergedSchema === undefined ||
      protoMerge.conflicts > 0 ||
      protoMerge.text !== toText(mergedSchema)
    ) {
      cases.push({ ours, theirs, sameList, status: "proto conflict" });
      continue;
    }
    const generated: Record<Side, Record<Variant, string>> = {
      base: generate(BASE),
      ours: generate(oursSchema),
      theirs: generate(theirsSchema),
      merged: generate(mergedSchema),
    };
    const result = mergeGenerated(generated);
    cases.push({
      ours,
      theirs,
      sameList,
      status: "replayed",
      outcomes: Object.fromEntries(
        VARIANTS.map((v) => [
          v,
          result[v].fileConflicts > 0
            ? "conflict"
            : result[v].fileCorrect
              ? "clean"
              : "clean but wrong",
        ]),
      ) as Record<Variant, Outcome>,
    });
  }
}

const replayed = cases.filter((c) => c.status === "replayed");
const LABELS: Record<Variant, string> = {
  base64: "base64",
  a: "Option A",
  b: "Option B",
  "a-manifest": "Option A + manifest",
  "b-manifest": "Option B + manifest",
};
const row = (title: string, subset: Case[]) =>
  VARIANTS.map((v) => {
    const n = (o: Outcome) =>
      subset.filter((c) => c.outcomes?.[v] === o).length;
    return `| ${title} | ${LABELS[v]} | ${n("clean")} | ${n("conflict")} | ${n("clean but wrong")} |`;
  });
const describe = (e: Edit) => `${e.op} (${LISTS[e.list]})`;
const wrongWithManifest = replayed.filter(
  (c) =>
    c.outcomes?.["a-manifest"] === "clean but wrong" ||
    c.outcomes?.["b-manifest"] === "clean but wrong",
);
const costCases = (e: "a" | "b") =>
  replayed.filter(
    (c) =>
      c.outcomes?.[e] === "clean" &&
      c.outcomes?.[`${e}-manifest`] === "conflict",
  );

const md = [
  "<!-- Generated by scripts/shift-matrix.ts -->",
  "",
  `Base schema: top-level messages ${BASE.messages.join(", ")}; ${PARENT} holds 3 nested messages, enums and extensions; 3 top-level enums, services and extensions. Each side applies one of ${OPS.length} edits to one of ${Object.keys(LISTS).length} lists: ${cases.length} ordered pairs, ${cases.length - replayed.length} of which conflict as .proto (e.g. both append to the same list) and are excluded.`,
  "",
  "Whole generated `_pb.ts`, compared with the file generated from the merged schema:",
  "",
  "| pairs | variant | clean | conflict | clean but wrong |",
  "| --- | --- | --- | --- | --- |",
  ...row(
    `same list (${replayed.filter((c) => c.sameList).length})`,
    replayed.filter((c) => c.sameList),
  ),
  ...row(
    `different lists (${replayed.filter((c) => !c.sameList).length})`,
    replayed.filter((c) => !c.sameList),
  ),
  "",
  `Clean but wrong with the manifest: ${wrongWithManifest.length}.`,
  ...wrongWithManifest.map(
    (c) => `- ours: ${describe(c.ours)}, theirs: ${describe(c.theirs)}`,
  ),
  "",
  ...(["a", "b"] as const).flatMap((e) => {
    const cost = costCases(e);
    const byKind = new Map<string, number>();
    for (const c of cost) {
      const key = c.sameList
        ? "same list"
        : `${LISTS[c.ours.list]} / ${LISTS[c.theirs.list]}`;
      byKind.set(key, (byKind.get(key) ?? 0) + 1);
    }
    return [
      `Correct clean merges that the manifest turns into conflicts with ${LABELS[e]}: ${cost.length}.`,
      ...[...byKind].map(([k, n]) => `- ${k}: ${n}`),
      "",
    ];
  }),
];

mkdirSync(resultsDir, { recursive: true });
writeFileSync(
  join(resultsDir, "shift-matrix.md"),
  `${md.join("\n").trimEnd()}\n`,
);
// One line per pair keeps the per-pair results reviewable in a diff.
writeFileSync(
  join(resultsDir, "shift-matrix.tsv"),
  `${[
    ["ours list", "ours edit", "theirs list", "theirs edit", ...VARIANTS].join(
      "\t",
    ),
    ...cases.map((c) =>
      [
        c.ours.list,
        c.ours.op,
        c.theirs.list,
        c.theirs.op,
        ...VARIANTS.map((v) => c.outcomes?.[v] ?? c.status),
      ].join("\t"),
    ),
  ].join("\n")}\n`,
);
console.log(md.join("\n"));
