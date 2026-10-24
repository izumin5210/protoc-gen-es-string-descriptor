import { equalBytes } from "./bytes.js";
import {
  decodeDescriptorExpr,
  extractDescriptorExpr,
} from "./descriptor-expr.js";
import {
  type Encoding,
  encodingOf,
  generate,
  VARIANTS,
  type Variant,
} from "./generate.js";
import { mergeFile } from "./tools.js";

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
export function replayPair(
  images: Record<Side, Uint8Array>,
  path: string,
): Record<Variant, MergeOutcome> {
  const generated = Object.fromEntries(
    Object.entries(images).map(([side, image]) => {
      const files = generate(image, [path]);
      if (files.length !== 1) {
        throw new Error(`expected one generated file, got ${files.length}`);
      }
      return [side, files[0].content];
    }),
  ) as Record<Side, Record<Variant, string>>;
  return mergeGenerated(generated);
}

export function mergeGenerated(
  generated: Record<Side, Record<Variant, string>>,
): Record<Variant, MergeOutcome> {
  const expected = decodeDescriptorExpr(
    extractDescriptorExpr(generated.merged.base64),
    "base64",
  );
  return Object.fromEntries(
    VARIANTS.map((variant): [Variant, MergeOutcome] => {
      const pick = (side: Side) => generated[side][variant];
      const expr = (side: Side) => `${extractDescriptorExpr(pick(side))}\n`;
      const merge = mergeFile(expr("ours"), expr("base"), expr("theirs"));
      const fileMerge = mergeFile(pick("ours"), pick("base"), pick("theirs"));
      const outcome: MergeOutcome = {
        conflicts: merge.conflicts,
        fileConflicts: fileMerge.conflicts,
        merged: merge.text,
        fileMerged: fileMerge.text,
      };
      if (merge.conflicts === 0) {
        outcome.correct = decodesTo(merge.text, encodingOf(variant), expected);
      }
      if (fileMerge.conflicts === 0) {
        outcome.fileCorrect = fileMerge.text === pick("merged");
        if (!outcome.fileCorrect) {
          outcome.fileWrong = whichPartDiffers(fileMerge.text, pick("merged"));
        }
      }
      return [variant, outcome];
    }),
  ) as Record<Variant, MergeOutcome>;
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
  encoding: Encoding,
  expected: Uint8Array,
): boolean {
  try {
    return equalBytes(decodeDescriptorExpr(expr, encoding), expected);
  } catch {
    return false;
  }
}
