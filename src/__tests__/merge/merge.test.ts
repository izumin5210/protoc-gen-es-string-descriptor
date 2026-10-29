import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bufBuildFiles, generate, mergeFile, tscErrors } from "../helpers.js";

const scenariosDir = join(import.meta.dirname, "scenarios");

type Side = "base" | "ours" | "theirs" | "merged";

/**
 * How a `git merge-file` of the generated code ends:
 * - "correct": clean, and identical to the code generated from the merged
 *   `.proto`;
 * - "conflict": git reports a conflict;
 * - `TS<code>: <message>`: the merged `.proto` is invalid, and the clean
 *   merge result fails `tsc` with this error.
 */
type Outcome = "correct" | "conflict" | `TS${number}: ${string}`;

const scenarios: Record<string, Outcome> = {
  "01-index-shift": "correct",
  "02-both-add-enums": "correct",
  "03-optional-adjacent": "correct",
  "04-optional-separated": "correct",
  "05-optional-both-append": "correct",
  "06-same-size": "correct",
  // Caught by the number types.
  "07-dup-field-number": "TS2300: Duplicate identifier '3'.",
  "08-dup-enum-number": "TS2300: Duplicate identifier '2'.",
  "09-dup-field-name": "TS2300: Duplicate identifier 'bio'.",
  "10-rename-vs-ref": "TS2304: Cannot find name 'User'.",
  "11-dup-message-name": "TS2300: Duplicate identifier 'Org'.",
  "12-public-import": "correct",
  "13-real-oneof-shift": "correct",
  "14-fields-separated": "correct",
  "15-rpcs-separated": "correct",
  "16-nested-different-parents": "correct",
  // Map entries are nested messages in the descriptor, so the two
  // additions end up next to each other.
  "17-map-vs-nested": "conflict",
  "18-imports-separated": "correct",
  // Members of oneofs in neighbouring messages; a single list of oneof
  // members for the whole file would have them next to each other.
  "19-oneof-members-in-two-messages": "correct",
};

/** The `.proto` files of one side: `m.proto` and the shared `deps/`. */
function protos(scenario: string, side: Side): Record<string, string> {
  const dir = join(scenariosDir, scenario);
  const deps = join(dir, "deps");
  const files: Record<string, string> = {};
  if (existsSync(deps)) {
    for (const name of readdirSync(deps)) {
      files[name] = readFileSync(join(deps, name), "utf8");
    }
  }
  if (side === "merged") {
    const read = (s: Side) => readFileSync(join(dir, `${s}.proto`), "utf8");
    const merged = mergeFile(read("ours"), read("base"), read("theirs"));
    expect(merged.conflicts, "the .proto files merge cleanly").toBe(0);
    files["m.proto"] = merged.text;
  } else {
    files["m.proto"] = readFileSync(join(dir, `${side}.proto`), "utf8");
  }
  return files;
}

/** Generated code of every file of one side, keyed by file name. */
function generateSide(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    generate(bufBuildFiles(files), Object.keys(files)).map((f) => [
      f.name,
      f.content,
    ]),
  );
}

describe("git merge-file of generated code", () => {
  it.each(Object.entries(scenarios))(
    "%s: %s",
    (scenario, outcome) => {
      const [base, ours, theirs] = (["base", "ours", "theirs"] as const).map(
        (side) => generateSide(protos(scenario, side)),
      );
      const merged = mergeFile(
        ours["m_pb.ts"],
        base["m_pb.ts"],
        theirs["m_pb.ts"],
      );
      if (outcome === "conflict") {
        expect(merged.conflicts).toBeGreaterThan(0);
        return;
      }
      expect(merged.conflicts).toBe(0);
      if (outcome === "correct") {
        expect(merged.text).toBe(
          generateSide(protos(scenario, "merged"))["m_pb.ts"],
        );
        return;
      }
      expect(() => generateSide(protos(scenario, "merged"))).toThrow(
        /buf build failed/,
      );
      const errors = tscErrors({ ...ours, ...theirs, "m_pb.ts": merged.text });
      expect(errors.filter((e) => e.endsWith(`error ${outcome}`))).not.toEqual(
        [],
      );
    },
    60_000,
  );
});
