import { join } from "node:path";
import ts from "typescript";
import { NAMES_RUNTIME, OPTION_B_RUNTIME } from "./generate.js";

const srcDir = import.meta.dirname;
/** Where the checked file pretends to live, so that packages resolve. */
const virtualDir = join(srcDir, "..", ".work", "typecheck");

const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  types: [],
  paths: {
    "protoc-gen-es-string-descriptor": [
      join(srcDir, "..", "..", "src", "runtime.ts"),
    ],
    [OPTION_B_RUNTIME]: [join(srcDir, "option-b", "runtime.ts")],
    [NAMES_RUNTIME]: [join(srcDir, "names", "runtime.ts")],
  },
};

// Library and dependency files are parsed once and shared by every check.
const cache = new Map<string, ts.SourceFile | undefined>();
const baseHost = ts.createCompilerHost(options);

/**
 * Type-check one generated `_pb.ts` with the TypeScript compiler, as a
 * project that compiles generated code would. Imports of other generated
 * files are not available and are ignored (TS2307). Returns
 * `TS<code>: <message>` for every other error.
 */
export function typeErrors(content: string, name = "file_pb.ts"): string[] {
  const path = join(virtualDir, name);
  const host: ts.CompilerHost = {
    ...baseHost,
    fileExists: (f) => f === path || baseHost.fileExists(f),
    readFile: (f) => (f === path ? content : baseHost.readFile(f)),
    getSourceFile: (f, languageVersion) => {
      if (f === path) {
        return ts.createSourceFile(f, content, languageVersion, true);
      }
      if (!cache.has(f)) {
        cache.set(f, baseHost.getSourceFile(f, languageVersion));
      }
      return cache.get(f);
    },
  };
  const program = ts.createProgram([path], options, host);
  const file = program.getSourceFile(path)!;
  return [
    ...program.getSyntacticDiagnostics(file),
    ...program.getSemanticDiagnostics(file),
  ]
    .filter((d) => d.code !== 2307)
    .map(
      (d) =>
        `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`,
    );
}
