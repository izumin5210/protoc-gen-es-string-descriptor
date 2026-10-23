import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import * as esbuild from "esbuild";
import { rollup } from "rollup";
import { extractDescriptorExpr } from "./descriptor-expr.js";
import {
  type Encoding,
  type GeneratedFile,
  generate,
  OPTION_B_RUNTIME,
} from "./generate.js";
import {
  cloneGoogleapis,
  GOOGLEAPIS_REV,
  materialize,
  showFile,
} from "./googleapis.js";
import { bufBuild } from "./tools.js";

/** The proto set that is bundled: one large public API. */
export const BUNDLE_PACKAGE = "google/cloud/aiplatform/v1";

const srcDir = import.meta.dirname;
const workDir = join(srcDir, "..", ".work", "bundle");
const runtimes = {
  shipped: {
    "protoc-gen-es-string-descriptor": join(
      srcDir,
      "..",
      "..",
      "src",
      "runtime.ts",
    ),
    [OPTION_B_RUNTIME]: join(srcDir, "option-b", "runtime.ts"),
  },
  direct: {
    "protoc-gen-es-string-descriptor": join(srcDir, "option-a-direct.ts"),
    [OPTION_B_RUNTIME]: join(srcDir, "option-b", "runtime-direct.ts"),
  },
};

/**
 * Generate JS for every file of {@link BUNDLE_PACKAGE} and its imports
 * (except well-known types, which @bufbuild/protobuf ships).
 */
export function generateBundleInputs(): GeneratedFile[] {
  const repo = cloneGoogleapis();
  const protos = listProtos(repo);
  // One synthetic file that imports the whole package lets `materialize`
  // collect the transitive closure at the pinned revision.
  const entry = protos.map((p) => `import "${p}";`).join("\n");
  const { root } = materialize(repo, GOOGLEAPIS_REV, "entry.proto", entry);
  try {
    rmSync(join(root, "entry.proto"));
    const image = bufBuild(root, BUNDLE_PACKAGE);
    const files = listFiles(root).filter(
      (f) => f.endsWith(".proto") && !f.startsWith("google/protobuf/"),
    );
    return generate(image, files, "target=js,import_extension=js");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function listProtos(repo: string): string[] {
  const out = showFile(repo, GOOGLEAPIS_REV, BUNDLE_PACKAGE);
  if (out === undefined) {
    throw new Error(`${BUNDLE_PACKAGE} not found`);
  }
  // `git show rev:dir` prints a tree listing headed by "tree rev:dir".
  return out
    .split("\n")
    .slice(1)
    .filter((name) => name.endsWith(".proto"))
    .map((name) => `${BUNDLE_PACKAGE}/${name}`);
}

function listFiles(root: string, dir = root): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? listFiles(root, join(dir, entry.name))
      : [relative(root, join(dir, entry.name))],
  );
}

const EMPTY_DESCRIPTOR: Record<Encoding, string> = {
  base64: '""',
  a: '""',
  b: "[]",
};

/**
 * Replace the embedded descriptor with an empty one, so that subtracting the
 * size of this bundle isolates the descriptors' share of the full bundle.
 */
function stubDescriptor(content: string, encoding: Encoding): string {
  const expr = extractDescriptorExpr(content);
  const deps = /(, \[[\w$, ]*\])?\);$/.exec(expr)?.[1] ?? "";
  return content.replace(
    expr,
    `fileDesc(${EMPTY_DESCRIPTOR[encoding]}${deps});`,
  );
}

export interface BundleInput {
  dir: string;
  entry: string;
}

/**
 * Lay out the generated files, an entry that keeps every file descriptor
 * alive, and the runtimes as local packages, all under `.work/bundle`.
 */
export async function writeBundleInput(
  files: GeneratedFile[],
  encoding: Encoding,
  options: { stub?: boolean; timing?: boolean; direct?: boolean } = {},
): Promise<BundleInput> {
  const name = [
    encoding,
    ...(["stub", "timing", "direct"] as const).filter((o) => options[o]),
  ].join("-");
  const dir = join(workDir, name);
  rmSync(dir, { recursive: true, force: true });
  const imports: string[] = [];
  const names: string[] = [];
  for (const file of files) {
    let content = file.content[encoding];
    if (options.stub) {
      content = stubDescriptor(content, encoding);
    }
    const path = join(dir, file.name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    const exported = /^export const (file_\w+)/m.exec(content)?.[1];
    if (exported !== undefined) {
      imports.push(`import { ${exported} } from "./${file.name}";`);
      names.push(exported);
    }
  }
  const runtime = runtimes[options.direct ? "direct" : "shipped"];
  for (const [pkg, source] of Object.entries(runtime)) {
    const pkgDir = join(dir, "node_modules", pkg);
    mkdirSync(pkgDir, { recursive: true });
    // Inline the runtime's own modules but keep @bufbuild/protobuf
    // external, so that the final bundle has a single copy of it.
    const { outputFiles } = await esbuild.build({
      entryPoints: [source],
      bundle: true,
      packages: "external",
      format: "esm",
      write: false,
    });
    writeFileSync(join(pkgDir, "index.js"), outputFiles[0].text);
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: pkg, type: "module", main: "index.js" }),
    );
  }
  // Bundlers keep module evaluation order, so the timer module runs before
  // any descriptor is hydrated and the entry body runs after all of them.
  const entryLines = [
    ...imports,
    `export const files = [${names.join(", ")}];`,
  ];
  if (options.timing) {
    writeFileSync(
      join(dir, "timer-start.js"),
      "globalThis.hydrateStart = performance.now();\n",
    );
    entryLines.unshift('import "./timer-start.js";');
    entryLines.push("globalThis.hydrateEnd = performance.now();");
  }
  const entry = join(dir, "entry.js");
  writeFileSync(entry, `${entryLines.join("\n")}\n`);
  return { dir, entry };
}

export async function bundleWithEsbuild(
  input: BundleInput,
  charset: "ascii" | "utf8" = "ascii",
): Promise<Uint8Array> {
  const result = await esbuild.build({
    entryPoints: [input.entry],
    bundle: true,
    minify: true,
    format: "esm",
    platform: "neutral",
    charset,
    write: false,
  });
  return result.outputFiles[0].contents;
}

export async function bundleWithRollup(
  input: BundleInput,
): Promise<Uint8Array> {
  const bundle = await rollup({
    input: input.entry,
    plugins: [nodeResolve()],
    onwarn: () => {},
  });
  const { output } = await bundle.generate({
    format: "es",
    plugins: [terser()],
  });
  await bundle.close();
  return new TextEncoder().encode(output[0].code);
}
