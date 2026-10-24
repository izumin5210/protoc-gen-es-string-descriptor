import { create, createFileRegistry, fromBinary } from "@bufbuild/protobuf";
import {
  type FileDescriptorProto,
  FileDescriptorSetSchema,
} from "@bufbuild/protobuf/wkt";
import { equalBytes } from "./bytes.js";
import {
  decodeDescriptorExpr,
  extractDescriptorExpr,
  parseFileDescCall,
} from "./descriptor-expr.js";
import {
  type DescriptorFormat,
  formatOf,
  generate,
  VARIANTS,
  type Variant,
} from "./generate.js";
import { hydrate } from "./hydrate.js";
import { fileDesc as namesFileDesc } from "./names/runtime.js";
import type { DescTree } from "./option-b/runtime.js";
import { protodescCheck } from "./protodesc.js";
import { mergeFile } from "./tools.js";
import { typeErrors } from "./typecheck.js";

export type Side = "base" | "ours" | "theirs" | "merged";

export interface MergeOutcome {
  /** Conflict hunks in the `fileDesc(...)` expression alone. */
  conflicts: number;
  /** Conflict hunks in the whole generated `_pb.ts` file. */
  fileConflicts: number;
  /** For clean merges: does the merged literal decode to the right bytes? */
  correct?: boolean;
  /**
   * For clean whole-file merges: is the result identical to the file
   * generated from the merged `.proto`? Catches positional references such
   * as `messageDesc(file, 12)` that both sides shifted the same way.
   */
  fileCorrect?: boolean;
  /** For clean but wrong whole-file merges: which part differs. */
  fileWrong?: { descriptor: boolean; rest: boolean };
  /**
   * For merges whose descriptor is clean but wrong: what protobuf-go's
   * protodesc says about it ("ok" means the error goes unnoticed).
   */
  protodesc?: string;
  /**
   * The whole-file result as a user would see it:
   * - "correct": identical to the regenerated file, or embeds the same
   *   descriptor with the same code once manifests and number types are
   *   ignored;
   * - "error": TypeScript or loading the descriptor fails;
   * - "wrong": no error, but different from the regenerated file (always,
   *   if the merged `.proto` is invalid).
   */
  verdict: Verdict;
  /** The TypeScript or load error, or "equivalent" for a non-identical match. */
  verdictDetail?: string;
  /** The merged `fileDesc(...)` expression, kept for the readable report. */
  merged: string;
  /** The merged `_pb.ts`, kept for the readable report. */
  fileMerged: string;
}

/**
 * Generate every variant for each side of a merge, merge them with
 * `git merge-file`, and check every clean result against the descriptor
 * and the file generated from the merged `.proto`.
 */
/** Every variant must embed exactly the bytes that protoc-gen-es embeds. */
export function assertRoundTrip(content: Record<Variant, string>): void {
  const expected = decodeDescriptorExpr(
    extractDescriptorExpr(content.base64),
    "base64",
  );
  for (const variant of VARIANTS) {
    const actual = decodeDescriptorExpr(
      extractDescriptorExpr(content[variant]),
      formatOf(variant),
    );
    if (!equalBytes(actual, expected)) {
      throw new Error(`${variant} does not round-trip`);
    }
  }
}

export type Verdict = "correct" | "conflict" | "error" | "wrong";

export function replayPair(
  images: Record<Exclude<Side, "merged">, Uint8Array> & { merged?: Uint8Array },
  path: string,
): Record<Variant, MergeOutcome> {
  const generated = Object.fromEntries(
    Object.entries(images)
      .filter(([, image]) => image !== undefined)
      .map(([side, image]) => {
        const files = generate(image, [path]);
        if (files.length !== 1) {
          throw new Error(`expected one generated file, got ${files.length}`);
        }
        assertRoundTrip(files[0].content);
        return [side, files[0].content];
      }),
  ) as Generated;
  // An invalid merged .proto has no image; the dependencies are the same.
  const files = fromBinary(
    FileDescriptorSetSchema,
    images.merged ?? images.base,
  ).file;
  const source = files.find((f) => f.name === path)!;
  const dependencies = files.filter((f) => f !== source);
  return mergeGenerated(
    generated,
    (embedded) => protodescCheck(embedded, source, dependencies),
    dependencies,
  );
}

type Generated = Record<Exclude<Side, "merged">, Record<Variant, string>> & {
  merged?: Record<Variant, string>;
};

export function mergeGenerated(
  generated: Generated,
  validate?: (embedded: Uint8Array) => string | undefined,
  dependencies: FileDescriptorProto[] = [],
): Record<Variant, MergeOutcome> {
  const expected =
    generated.merged &&
    decodeDescriptorExpr(
      extractDescriptorExpr(generated.merged.base64),
      "base64",
    );
  const load = loader(dependencies);
  return Object.fromEntries(
    VARIANTS.map((variant): [Variant, MergeOutcome] => {
      const pick = (side: Side) => generated[side]![variant];
      const expr = (side: Side) => `${extractDescriptorExpr(pick(side))}\n`;
      const merge = mergeFile(expr("ours"), expr("base"), expr("theirs"));
      const fileMerge = mergeFile(pick("ours"), pick("base"), pick("theirs"));
      const outcome: MergeOutcome = {
        conflicts: merge.conflicts,
        fileConflicts: fileMerge.conflicts,
        merged: merge.text,
        fileMerged: fileMerge.text,
        ...judge(
          fileMerge,
          generated.merged?.[variant],
          formatOf(variant),
          load,
        ),
      };
      if (expected === undefined) {
        return [variant, outcome];
      }
      if (merge.conflicts === 0) {
        outcome.correct = decodesTo(merge.text, formatOf(variant), expected);
      }
      if (fileMerge.conflicts === 0) {
        outcome.fileCorrect = fileMerge.text === pick("merged");
        if (!outcome.fileCorrect) {
          outcome.fileWrong = whichPartDiffers(fileMerge.text, pick("merged"));
        }
      }
      const wrongDescriptor =
        outcome.correct === false
          ? merge.text
          : outcome.fileWrong?.descriptor
            ? extractDescriptorExpr(fileMerge.text)
            : undefined;
      if (validate !== undefined && wrongDescriptor !== undefined) {
        try {
          outcome.protodesc = validate(
            decodeDescriptorExpr(wrongDescriptor, formatOf(variant)),
          );
        } catch (e) {
          outcome.protodesc = `not decodable: ${e}`;
        }
      }
      return [variant, outcome];
    }),
  ) as Record<Variant, MergeOutcome>;
}

/**
 * Load an embedded descriptor as protobuf-es would, with the files that the
 * `imports` identifiers refer to.
 */
function loader(dependencies: FileDescriptorProto[]) {
  const registry = createFileRegistry(
    create(FileDescriptorSetSchema, { file: dependencies }),
  );
  // protoc-gen-es names the export of `a/b.proto` `file_a_b`.
  const byIdentifier = new Map(
    [...registry.files].map((f) => [
      `file_${f.name.replace(/[^a-zA-Z0-9_]+/g, "_")}`,
      f,
    ]),
  );
  return (expr: string, format: DescriptorFormat) => {
    const imports = parseFileDescCall(expr, format).imports.map((id) => {
      const file = byIdentifier.get(id);
      if (file === undefined) {
        throw new Error(`unknown import ${id}`);
      }
      return file;
    });
    if (format === "names") {
      // The names runtime, as generated code would call it.
      const { arg } = parseFileDescCall(expr, format);
      namesFileDesc(arg as DescTree, imports);
    } else {
      hydrate(decodeDescriptorExpr(expr, format), imports);
    }
  };
}

function judge(
  merge: { text: string; conflicts: number },
  expected: string | undefined,
  format: DescriptorFormat,
  load: ReturnType<typeof loader>,
): Pick<MergeOutcome, "verdict" | "verdictDetail"> {
  if (merge.conflicts > 0) {
    return { verdict: "conflict" };
  }
  if (merge.text === expected) {
    return { verdict: "correct" };
  }
  const [typeError] = typeErrors(merge.text);
  if (typeError !== undefined) {
    return { verdict: "error", verdictDetail: typeError };
  }
  let actual: Uint8Array;
  try {
    const expr = extractDescriptorExpr(merge.text);
    load(expr, format);
    actual = decodeDescriptorExpr(expr, format);
  } catch (e) {
    return { verdict: "error", verdictDetail: `load: ${e}` };
  }
  if (expected === undefined) {
    return { verdict: "wrong" };
  }
  const want = extractDescriptorExpr(expected);
  const same =
    equalBytes(actual, decodeDescriptorExpr(want, format)) &&
    codeOutsideDescriptor(merge.text) === codeOutsideDescriptor(expected);
  return same
    ? { verdict: "correct", verdictDetail: "equivalent" }
    : { verdict: "wrong" };
}

/** The file without the descriptor, comments and number types. */
function codeOutsideDescriptor(content: string): string {
  return content
    .replace(extractDescriptorExpr(content), "")
    .replace(/^(export )?type _numbers_[\w$]+ = \{\n[\s\S]*?^\};\n/gm, "")
    .replace(/^\/\/.*\n/gm, "");
}

function whichPartDiffers(
  actual: string,
  expected: string,
): { descriptor: boolean; rest: boolean } {
  const split = (content: string) => {
    try {
      const expr = extractDescriptorExpr(content);
      return { expr, rest: content.replace(expr, "") };
    } catch {
      return { expr: "", rest: content };
    }
  };
  const a = split(actual);
  const e = split(expected);
  return { descriptor: a.expr !== e.expr, rest: a.rest !== e.rest };
}

function decodesTo(
  expr: string,
  encoding: DescriptorFormat,
  expected: Uint8Array,
): boolean {
  try {
    return equalBytes(decodeDescriptorExpr(expr, encoding), expected);
  } catch {
    return false;
  }
}
