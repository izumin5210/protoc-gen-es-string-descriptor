/**
 * Apply every pair of single edits to a small schema, merge the generated
 * `_pb.ts` of every variant with `git merge-file`, and compare the result
 * with the file generated from the merged schema.
 *
 * The edits cover every list whose positions generated code or the
 * embedded descriptor refers to, plus lists whose container carries a length
 * prefix in Option A (fields, enum values, methods). Each pair runs twice:
 * once with both sides adding elements of the same byte size, once not.
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
import {
  generateFromProtos,
  VARIANT_LABELS,
  VARIANTS,
  type Variant,
} from "../src/generate.js";
import { protodescAvailable, protodescCheck } from "../src/protodesc.js";
import {
  assertRoundTrip,
  mergeGenerated,
  type Side,
} from "../src/replay-pair.js";
import { mergeFile } from "../src/tools.js";

const resultsDir = join(import.meta.dirname, "..", "results");
const FILE = "shift.proto";
const PACKAGE = "shift.v1";

/** A schema reduced to the lists the matrix edits. */
interface Schema {
  imports: string[];
  publicImports: string[];
  messages: string[];
  nestedMessages: string[];
  enums: string[];
  nestedEnums: string[];
  services: string[];
  extensions: string[];
  nestedExtensions: string[];
  /**
   * Fields of PARENT in declaration order. The prefix is the kind: "f" plain,
   * "o" proto3 optional (with a synthetic oneof), "c" the only field of a
   * real oneof. The kinds are interleaved, so that an edit to one kind can be
   * separated from the other side's edit by an unchanged field.
   */
  fields: string[];
  enumValues: string[];
  methods: string[];
}

type List = Exclude<keyof Schema, "publicImports">;

interface ListInfo {
  label: string;
  /** What kind of positional reference the list is about. */
  group: string;
  /** Prefix of the elements that the sides add. */
  prefix: string;
}

// PARENT holds the nested lists and the fields, ENUM the values and SERVICE
// the methods. None of them is ever deleted, and PARENT moves when the
// top-level messages before it change.
const PARENT = "B";
const ENUM = "E2";
const SERVICE = "S2";

const LISTS: Record<List, ListInfo> = {
  imports: { label: "import", group: "imports", prefix: "dep/" },
  messages: { label: "message", group: "generated code", prefix: "M" },
  nestedMessages: {
    label: "nested message",
    group: "generated code",
    prefix: "N",
  },
  enums: { label: "enum", group: "generated code", prefix: "En" },
  nestedEnums: { label: "nested enum", group: "generated code", prefix: "Ne" },
  services: { label: "service", group: "generated code", prefix: "Sv" },
  extensions: { label: "extension", group: "generated code", prefix: "x" },
  nestedExtensions: {
    label: "nested extension",
    group: "generated code",
    prefix: "nx",
  },
  fields: { label: "field", group: "fields and oneofs", prefix: "" },
  enumValues: { label: "enum value", group: "container", prefix: `${ENUM}_` },
  methods: { label: "method", group: "container", prefix: "Rpc" },
};

const BASE: Schema = {
  imports: ["dep/d1.proto", "dep/d2.proto", "dep/d3.proto"],
  // No import starts public: B groups consecutive varints on one line, so an
  // existing public_dependency would make every pair of import edits touch
  // the same line and hide the case the imports block is for.
  publicImports: [],
  messages: ["A", PARENT, "C"],
  nestedMessages: ["B1", "B2", "B3"],
  enums: ["E1", ENUM, "E3"],
  nestedEnums: ["BE1", "BE2", "BE3"],
  services: ["S1", SERVICE, "S3"],
  extensions: ["x1", "x2", "x3"],
  nestedExtensions: ["bx1", "bx2", "bx3"],
  fields: ["f1", "o1", "f2", "o2", "c1", "f3", "o3", "c2", "f4"],
  enumValues: [`${ENUM}_A`, `${ENUM}_B`, `${ENUM}_C`],
  methods: ["Rpc1", "Rpc2", "Rpc3"],
};

type Op =
  | "insert front"
  | "insert middle"
  | "append"
  | "delete first"
  | "delete last"
  | "make public";
const OPS: Op[] = [
  "insert front",
  "insert middle",
  "append",
  "delete first",
  "delete last",
];

type FieldKind = "f" | "o" | "c";
const FIELD_KINDS: Record<FieldKind, string> = {
  f: "plain field",
  o: "proto3 optional field",
  c: "oneof",
};

interface Edit {
  list: List;
  op: Op;
  /** For fields: the kind of field added or deleted. */
  kind?: FieldKind;
}

type SizeMode = "same size" | "different size";

/**
 * Both sides add elements with names of equal length in "same size" mode,
 * so that Option A's length prefixes change identically on both sides.
 */
function newName(
  list: List,
  side: "ours" | "theirs",
  size: SizeMode,
  kind?: FieldKind,
): string {
  const prefix = kind ?? LISTS[list].prefix;
  const tag = side === "ours" ? "O" : size === "same size" ? "T" : "Theirs";
  const name = `${prefix}${tag}`;
  if (list === "imports") {
    return `${name.toLowerCase()}.proto`;
  }
  if (list === "enumValues") {
    return name.toUpperCase();
  }
  return prefix === prefix.toLowerCase() ? name.toLowerCase() : name;
}

/** Edits are anchored on base elements, so both sides compose. */
function apply(
  schema: Schema,
  edit: Edit,
  side: "ours" | "theirs",
  size: SizeMode,
): Schema {
  // Field edits insert at positions of the whole field list, but delete the
  // first or last field of their kind.
  const base = BASE[edit.list];
  const ofKind = edit.kind
    ? base.filter((name) => name.startsWith(edit.kind!))
    : base;
  const items = [...schema[edit.list]];
  const added = newName(edit.list, side, size, edit.kind);
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
      before(base[Math.floor(base.length / 2)]);
      break;
    case "append":
      items.push(added);
      break;
    case "delete first":
    case "delete last": {
      const name =
        edit.op === "delete first" ? ofKind[0] : ofKind[ofKind.length - 1];
      if (!items.includes(name)) {
        throw new Error(`${name} is gone`);
      }
      items.splice(items.indexOf(name), 1);
      break;
    }
    case "make public": {
      const name = base[1];
      if (!items.includes(name) || schema.publicImports.includes(name)) {
        throw new Error(`${name} cannot be made public`);
      }
      return { ...schema, publicImports: [...schema.publicImports, name] };
    }
  }
  return {
    ...schema,
    [edit.list]: items,
    publicImports: schema.publicImports.filter(
      (name) => edit.list !== "imports" || items.includes(name),
    ),
  };
}

// Numbers are assigned on first sight, per kind, and stay below 128 (or all
// at 3 bytes for extensions) so that they never change an element's size.
const numbers = new Map<string, number>();
function numberOf(kind: string, name: string, first: number): number {
  const key = `${kind}:${name}`;
  let n = numbers.get(key);
  if (n === undefined) {
    n =
      first +
      [...numbers.keys()].filter((k) => k.startsWith(`${kind}:`)).length;
    numbers.set(key, n);
  }
  return n;
}

const stringField = (
  name: string,
  number: number,
  extra: MessageInitShape<typeof FieldDescriptorProtoSchema> = {},
): MessageInitShape<typeof FieldDescriptorProtoSchema> => ({
  name,
  number,
  label: FieldDescriptorProto_Label.OPTIONAL,
  type: FieldDescriptorProto_Type.STRING,
  jsonName: name.replace(/_(\w)/g, (_, c: string) => c.toUpperCase()),
  ...extra,
});

function extension(name: string) {
  return stringField(name, numberOf("ext", name, 50001), {
    extendee: ".google.protobuf.MessageOptions",
  });
}

function enumType(
  name: string,
  values: string[] = [],
): MessageInitShape<typeof EnumDescriptorProtoSchema> {
  return {
    name,
    value: [
      { name: `${name.toUpperCase()}_UNSPECIFIED`, number: 0 },
      ...values.map((v) => ({ name: v, number: numberOf("value", v, 1) })),
    ],
  };
}

/** The descriptor protoc would produce for the schema. */
function toProto(schema: Schema): FileDescriptorProto {
  const dependency = ["google/protobuf/descriptor.proto", ...schema.imports];
  const realOneofs = schema.fields.filter((f) => f.startsWith("c"));
  const optionals = schema.fields.filter((f) => f.startsWith("o"));
  const parent = (): MessageInitShape<typeof DescriptorProtoSchema> => ({
    name: PARENT,
    field: schema.fields.map((f) => {
      const number = numberOf("field", f, 1);
      if (f.startsWith("o")) {
        // protoc puts synthetic oneofs after all real ones.
        return stringField(f, number, {
          proto3Optional: true,
          oneofIndex: realOneofs.length + optionals.indexOf(f),
        });
      }
      if (f.startsWith("c")) {
        return stringField(`${f}_v`, number, {
          oneofIndex: realOneofs.indexOf(f),
        });
      }
      return stringField(f, number);
    }),
    oneofDecl: [
      ...realOneofs.map((c) => ({ name: c })),
      ...optionals.map((o) => ({ name: `_${o}` })),
    ],
    nestedType: schema.nestedMessages.map((n) => ({ name: n })),
    enumType: schema.nestedEnums.map((n) => enumType(n)),
    extension: schema.nestedExtensions.map(extension),
  });
  return create(FileDescriptorProtoSchema, {
    name: FILE,
    package: PACKAGE,
    syntax: "proto3",
    dependency,
    publicDependency: dependency.flatMap((d, i) =>
      schema.publicImports.includes(d) ? [i] : [],
    ),
    messageType: schema.messages.map((name) =>
      name === PARENT ? parent() : { name },
    ),
    enumType: schema.enums.map((name) =>
      enumType(name, name === ENUM ? schema.enumValues : []),
    ),
    service: schema.services.map((name) => ({
      name,
      method:
        name === SERVICE
          ? schema.methods.map((m) => ({
              name: m,
              inputType: `.${PACKAGE}.${PARENT}`,
              outputType: `.${PACKAGE}.${PARENT}`,
            }))
          : [],
    })),
    extension: schema.extensions.map(extension),
  });
}

/**
 * The same schema as .proto text, one block per element with blank lines in
 * between, to tell whether the edits would merge cleanly as .proto at all.
 * Field order in the text is the field order in the descriptor.
 */
function toText(schema: Schema): string {
  const ext = (name: string, pad: string) =>
    `${pad}extend google.protobuf.MessageOptions {\n${pad}  string ${name} = ${numberOf("ext", name, 50001)};\n${pad}}\n`;
  const en = (name: string, pad: string, values: string[] = []) =>
    [
      `${pad}enum ${name} {\n${pad}  ${name.toUpperCase()}_UNSPECIFIED = 0;\n`,
      ...values.map((v) => `${pad}  ${v} = ${numberOf("value", v, 1)};\n`),
      `${pad}}\n`,
    ].join("\n");
  const blocks = [
    `syntax = "proto3";\n\npackage ${PACKAGE};\n\nimport "google/protobuf/descriptor.proto";\n`,
    ...schema.imports.map(
      (i) =>
        `import ${schema.publicImports.includes(i) ? "public " : ""}"${i}";\n`,
    ),
    ...schema.messages.map((name) =>
      name === PARENT
        ? [
            `message ${name} {\n`,
            ...schema.fields.map((f) => {
              const number = numberOf("field", f, 1);
              return f.startsWith("o")
                ? `  optional string ${f} = ${number};\n`
                : f.startsWith("c")
                  ? `  oneof ${f} {\n    string ${f}_v = ${number};\n  }\n`
                  : `  string ${f} = ${number};\n`;
            }),
            ...schema.nestedMessages.map((n) => `  message ${n} {\n  }\n`),
            ...schema.nestedEnums.map((n) => en(n, "  ")),
            ...schema.nestedExtensions.map((n) => ext(n, "  ")),
            "}\n",
          ].join("\n")
        : `message ${name} {\n}\n`,
    ),
    ...schema.enums.map((n) => en(n, "", n === ENUM ? schema.enumValues : [])),
    ...schema.services.map((n) =>
      n === SERVICE
        ? [
            `service ${n} {\n`,
            ...schema.methods.map(
              (m) => `  rpc ${m}(${PARENT}) returns (${PARENT});\n`,
            ),
            "}\n",
          ].join("\n")
        : `service ${n} {\n}\n`,
    ),
    ...schema.extensions.map((n) => ext(n, "")),
  ];
  return blocks.join("\n");
}

const descriptorProto = file_google_protobuf_descriptor.proto;
const depNames = [
  ...BASE.imports,
  ...(["ours", "theirs"] as const).flatMap((side) =>
    (["same size", "different size"] as const).map((size) =>
      newName("imports", side, size),
    ),
  ),
];
const deps = [...new Set(depNames)].map((name) =>
  create(FileDescriptorProtoSchema, {
    name,
    package: name.replace(/\.proto$/, "").replaceAll("/", "."),
    syntax: "proto3",
  }),
);

const generatedCache = new Map<string, Record<Variant, string>>();
function generate(schema: Schema): Record<Variant, string> {
  const key = JSON.stringify(schema);
  let content = generatedCache.get(key);
  if (content === undefined) {
    const file = toProto(schema);
    [{ content }] = generateFromProtos(
      [descriptorProto, ...deps, file],
      [FILE],
    );
    assertRoundTrip(content);
    generatedCache.set(key, content);
  }
  return content;
}

type Outcome =
  | "clean"
  | "conflict"
  | "error"
  | "wrong code"
  | "wrong descriptor, Go rejects"
  | "wrong descriptor, Go accepts"
  | "wrong descriptor";

interface Case {
  size: SizeMode;
  ours: Edit;
  theirs: Edit;
  sameList: boolean;
  status: "replayed" | "proto conflict";
  outcomes?: Record<Variant, Outcome>;
}

const edits: Edit[] = (Object.keys(LISTS) as List[]).flatMap((list): Edit[] => {
  if (list === "fields") {
    return (Object.keys(FIELD_KINDS) as FieldKind[]).flatMap((kind) =>
      OPS.map((op) => ({ list, op, kind })),
    );
  }
  return [
    ...OPS,
    ...(list === "imports" ? (["make public"] as const) : []),
  ].map((op) => ({ list, op }));
});
const baseText = toText(BASE);
const cases: Case[] = [];
for (const size of ["same size", "different size"] as const) {
  for (const ours of edits) {
    for (const theirs of edits) {
      const sameList = ours.list === theirs.list;
      let oursSchema: Schema;
      let theirsSchema: Schema;
      let mergedSchema: Schema | undefined;
      try {
        oursSchema = apply(BASE, ours, "ours", size);
        theirsSchema = apply(BASE, theirs, "theirs", size);
      } catch {
        continue;
      }
      try {
        mergedSchema = apply(oursSchema, theirs, "theirs", size);
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
        cases.push({ size, ours, theirs, sameList, status: "proto conflict" });
        continue;
      }
      const generated: Record<Side, Record<Variant, string>> = {
        base: generate(BASE),
        ours: generate(oursSchema),
        theirs: generate(theirsSchema),
        merged: generate(mergedSchema),
      };
      const merged = mergedSchema;
      const result = mergeGenerated(
        generated,
        (embedded) =>
          protodescCheck(embedded, toProto(merged), [descriptorProto, ...deps]),
        [descriptorProto, ...deps],
      );
      cases.push({
        size,
        ours,
        theirs,
        sameList,
        status: "replayed",
        outcomes: Object.fromEntries(
          VARIANTS.map((v): [Variant, Outcome] => {
            const o = result[v];
            if (o.fileConflicts > 0) {
              return [v, "conflict"];
            }
            if (o.verdict === "correct") {
              return [v, "clean"];
            }
            if (o.verdict === "error") {
              return [v, "error"];
            }
            if (!o.fileWrong?.descriptor) {
              return [v, "wrong code"];
            }
            return [
              v,
              o.protodesc === undefined
                ? "wrong descriptor"
                : o.protodesc === "ok"
                  ? "wrong descriptor, Go accepts"
                  : "wrong descriptor, Go rejects",
            ];
          }),
        ) as Record<Variant, Outcome>,
      });
    }
  }
}

const replayed = cases.filter((c) => c.status === "replayed");
const isWrong = (o: Outcome | undefined) => o?.startsWith("wrong") === true;
const count = (subset: Case[], v: Variant, pred: (o: Outcome) => boolean) =>
  subset.filter((c) => c.outcomes !== undefined && pred(c.outcomes[v])).length;
const groupOf = (c: Case) => {
  const groups = [LISTS[c.ours.list].group, LISTS[c.theirs.list].group];
  return c.sameList
    ? `same list: ${LISTS[c.ours.list].group}`
    : groups[0] === groups[1]
      ? `different lists: ${groups[0]}`
      : "different lists: mixed";
};
const describe = (e: Edit) =>
  `${e.op} (${e.kind ? FIELD_KINDS[e.kind] : LISTS[e.list].label})`;

// Without Go, wrong descriptors are not validated and get one column.
const summaryHeader = protodescAvailable()
  ? "| variant | clean | conflict | error | clean but wrong: code | clean but wrong: descriptor, Go rejects | clean but wrong: descriptor, Go accepts |"
  : "| variant | clean | conflict | error | clean but wrong: code | clean but wrong: descriptor (not validated) |";
const summaryRows = (subset: Case[]) =>
  VARIANTS.map(
    (v) =>
      `| ${VARIANT_LABELS[v]} | ${count(subset, v, (o) => o === "clean")} | ${count(subset, v, (o) => o === "conflict")} | ${count(subset, v, (o) => o === "error")} | ${count(subset, v, (o) => o === "wrong code")} | ${
        protodescAvailable()
          ? `${count(subset, v, (o) => o === "wrong descriptor, Go rejects")} | ${count(subset, v, (o) => o === "wrong descriptor, Go accepts")}`
          : count(subset, v, (o) => o === "wrong descriptor")
      } |`,
  );

const groups = [...new Set(replayed.map(groupOf))].sort();
const COSTS: [Variant, Variant][] = [
  ["a", "a-manifest"],
  ["b", "b-index-manifest"],
  ["b", "b-manifest"],
  ["b-names", "b-names-numbers"],
];
const wrongWith = (v: Variant) =>
  replayed.filter((c) => isWrong(c.outcomes?.[v]));

// Only pairs where some variant merges wrong or a manifest changes the
// outcome; the others are all clean or all conflicts, and shift-matrix.md
// counts them.
const informative = cases.filter(
  (c) =>
    c.outcomes !== undefined &&
    (VARIANTS.some((v) => isWrong(c.outcomes?.[v])) ||
      COSTS.some(([w, m]) => c.outcomes?.[w] !== c.outcomes?.[m]) ||
      c.outcomes["b-name-table-numbers"] !== c.outcomes["b-names-numbers"]),
);
// Where the name table and the inline markers merge differently.
const tableVsInline = replayed.filter(
  (c) =>
    c.outcomes?.["b-name-table-numbers"] !== c.outcomes?.["b-names-numbers"],
);
const md = [
  "<!-- Generated by scripts/shift-matrix.ts -->",
  "",
  `Base schema: 3 elements in each of ${Object.keys(LISTS).length - 1} lists (${Object.values(
    LISTS,
  )
    .filter((l) => l.label !== "field")
    .map((l) => l.label)
    .join(
      ", ",
    )}), plus 9 fields of one message: plain, proto3 optional and real oneof fields, interleaved. Each side applies one edit (${OPS.join(", ")}; fields are added and deleted per kind; imports can also be made public). Every ordered pair runs twice: with both sides adding elements of the same byte size, and of different sizes. ${cases.length} pairs, ${cases.length - replayed.length} of which conflict as .proto (e.g. both append to the same list) and are excluded.`,
  "",
  `Whole generated \`_pb.ts\`, compared with the file generated from the merged schema. *Clean* also counts merges that differ from it only in comments, number types or the text of \`fileDesc(…)\`, but decode to the same descriptor. *Error* means that the TypeScript compiler or loading the descriptor fails${protodescAvailable() ? "; wrong descriptors are loaded with protobuf-go's `protodesc.NewFiles`" : " (Go not available: wrong descriptors were not validated)"}:`,
  "",
  `#### All ${replayed.length} replayed pairs`,
  "",
  summaryHeader,
  summaryHeader.replace(/[^|]+/g, " --- "),
  ...summaryRows(replayed),
  "",
  ...(["same size", "different size"] as const).flatMap((size) => [
    `#### ${size} (${replayed.filter((c) => c.size === size).length})`,
    "",
    summaryHeader,
    summaryHeader.replace(/[^|]+/g, " --- "),
    ...summaryRows(replayed.filter((c) => c.size === size)),
    "",
  ]),
  "#### Clean but wrong, by kind of edit pair",
  "",
  `| pairs | ${VARIANTS.map((v) => VARIANT_LABELS[v]).join(" | ")} |`,
  `| --- | ${VARIANTS.map(() => "---").join(" | ")} |`,
  ...groups.map((g) => {
    const subset = replayed.filter((c) => groupOf(c) === g);
    return `| ${g} (${subset.length}) | ${VARIANTS.map((v) => count(subset, v, isWrong)).join(" | ")} |`;
  }),
  "",
  `#### ${VARIANT_LABELS["b-name-table-numbers"]} → ${VARIANT_LABELS["b-names-numbers"]}: ${tableVsInline.length} pairs differ`,
  "",
  ...tableVsInline.map(
    (c) =>
      `- ${c.size}: ours ${describe(c.ours)}, theirs ${describe(c.theirs)}: ${c.outcomes?.["b-name-table-numbers"]} → ${c.outcomes?.["b-names-numbers"]}`,
  ),
  "",
  "#### Cost: correct clean merges that a manifest or the number types turn into conflicts",
  "",
  "| without → with | correct → conflict | wrong → conflict | still wrong |",
  "| --- | --- | --- | --- |",
  ...COSTS.map(([without, withM]) => {
    const n = (pred: (w: Outcome, m: Outcome) => boolean) =>
      replayed.filter(
        (c) => c.outcomes && pred(c.outcomes[without], c.outcomes[withM]),
      ).length;
    return `| ${VARIANT_LABELS[without]} → ${VARIANT_LABELS[withM]} | ${n((w, m) => w === "clean" && m === "conflict")} | ${n((w, m) => isWrong(w) && m === "conflict")} | ${n((_, m) => isWrong(m))} |`;
  }),
  "",
  ...(["b-manifest", "b-names-numbers"] as const).flatMap((v) => [
    `#### Clean but wrong with ${VARIANT_LABELS[v]}: ${wrongWith(v).length}`,
    "",
    ...wrongWith(v).map(
      (c) =>
        `- ${c.size}: ours ${describe(c.ours)}, theirs ${describe(c.theirs)}: ${c.outcomes?.[v]}`,
    ),
    "",
  ]),
  `shift-matrix.tsv lists the ${informative.length} pairs where some variant is clean but wrong, a manifest or the number types change the outcome, or the name table and the inline markers differ.`,
];

mkdirSync(resultsDir, { recursive: true });
writeFileSync(
  join(resultsDir, "shift-matrix.md"),
  `${md.join("\n").trimEnd()}\n`,
);
writeFileSync(
  join(resultsDir, "shift-matrix.tsv"),
  `${[
    [
      "size",
      "ours list",
      "ours edit",
      "theirs list",
      "theirs edit",
      ...VARIANTS,
    ].join("\t"),
    ...informative.map((c) =>
      [
        c.size,
        c.ours.kind ? `${c.ours.list}:${c.ours.kind}` : c.ours.list,
        c.ours.op,
        c.theirs.kind ? `${c.theirs.list}:${c.theirs.kind}` : c.theirs.list,
        c.theirs.op,
        ...VARIANTS.map((v) => c.outcomes?.[v] ?? c.status),
      ].join("\t"),
    ),
  ].join("\n")}\n`,
);
console.log(md.join("\n"));
