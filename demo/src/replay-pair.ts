import { equalBytes } from "./bytes.js";
import {
  decodeDescriptorExpr,
  extractDescriptorExpr,
} from "./descriptor-expr.js";
import { ENCODINGS, type Encoding, generate } from "./generate.js";
import { mergeFile } from "./tools.js";

export type Side = "base" | "ours" | "theirs" | "merged";

export interface EncodingOutcome {
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
  /** The merged `fileDesc(...)` expression, kept for the readable report. */
  merged: string;
}

/**
 * Generate all three encodings for each side of a merge, merge them with
 * `git merge-file`, and check every clean result against the descriptor
 * built from the merged `.proto`.
 */
export function replayPair(
  images: Record<Side, Uint8Array>,
  path: string,
): Record<Encoding, EncodingOutcome> {
  const generated = Object.fromEntries(
    Object.entries(images).map(([side, image]) => {
      const files = generate(image, [path]);
      if (files.length !== 1) {
        throw new Error(`expected one generated file, got ${files.length}`);
      }
      return [side, files[0].content];
    }),
  ) as Record<Side, Record<Encoding, string>>;

  const expected = decodeDescriptorExpr(
    extractDescriptorExpr(generated.merged.base64),
    "base64",
  );
  return Object.fromEntries(
    ENCODINGS.map((encoding): [Encoding, EncodingOutcome] => {
      const pick = (side: Side) => generated[side][encoding];
      const expr = (side: Side) => `${extractDescriptorExpr(pick(side))}\n`;
      const merge = mergeFile(expr("ours"), expr("base"), expr("theirs"));
      const fileMerge = mergeFile(pick("ours"), pick("base"), pick("theirs"));
      const outcome: EncodingOutcome = {
        conflicts: merge.conflicts,
        fileConflicts: fileMerge.conflicts,
        merged: merge.text,
      };
      if (merge.conflicts === 0) {
        outcome.correct = decodesTo(merge.text, encoding, expected);
      }
      if (fileMerge.conflicts === 0) {
        outcome.fileCorrect = fileMerge.text === pick("merged");
      }
      return [encoding, outcome];
    }),
  ) as Record<Encoding, EncodingOutcome>;
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
