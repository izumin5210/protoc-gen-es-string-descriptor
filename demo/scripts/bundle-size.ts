/**
 * Bundle every file descriptor of a large googleapis package with real
 * bundlers and report raw / gzip / brotli sizes per encoding.
 *
 * Usage: pnpm --filter demo bundle-size
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { version as esbuildVersion } from "esbuild";
import { VERSION as rollupVersion } from "rollup";
import {
  BUNDLE_PACKAGE,
  bundleWithEsbuild,
  bundleWithRollup,
  generateBundleInputs,
  writeBundleInput,
} from "../src/bundle.js";
import { extractDescriptorExpr } from "../src/descriptor-expr.js";
import { ENCODINGS, type Encoding } from "../src/generate.js";
import { GOOGLEAPIS_REV } from "../src/googleapis.js";

const resultsDir = join(import.meta.dirname, "..", "results");
const LABELS = {
  base64: "base64",
  a: "String literal",
  b: "Nested array",
} as const;

interface Sizes {
  raw: number;
  gzip: number;
  brotli: number;
}

function sizes(bytes: Uint8Array): Sizes {
  return {
    raw: bytes.length,
    gzip: gzipSync(bytes, { level: 9 }).length,
    brotli: brotliCompressSync(bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).length,
  };
}

/** How a minifier printed literals; diffed against the stub bundle below. */
function count(code: string) {
  return {
    // "a"+"b" chains that survived minification.
    stringConcats: code.match(/["'`]\+["'`]/g)?.length ?? 0,
    hexEscapes: code.match(/\\x[0-9a-fA-F]{2}/g)?.length ?? 0,
    unicodeEscapes: code.match(/\\u[0-9a-fA-F]{4}/g)?.length ?? 0,
    // Line feeds are left out because minified code has them anyway.
    rawControlChars: countChars(
      code,
      (c) => (c < 0x20 && c !== 0x0a) || c === 0x7f,
    ),
    rawNonAscii: countChars(code, (c) => c > 0x7f),
    backticks: code.match(/`/g)?.length ?? 0,
  };
}

function countChars(code: string, match: (charCode: number) => boolean) {
  let n = 0;
  for (let i = 0; i < code.length; i++) {
    if (match(code.charCodeAt(i))) {
      n++;
    }
  }
  return n;
}

type Counts = ReturnType<typeof count>;

function diffCounts(full: Counts, stub: Counts): Counts {
  return Object.fromEntries(
    Object.entries(full).map(([k, v]) => [k, v - stub[k as keyof Counts]]),
  ) as Counts;
}

/** A visible rendering of how the start of one descriptor was printed. */
function sample(code: string): string {
  const at = code.indexOf("google/api/annotations.proto");
  if (at < 0) {
    return "(not readable: base64)";
  }
  return [...code.slice(Math.max(0, at - 3), at + 70)]
    .map((c) => {
      const n = c.charCodeAt(0);
      return n < 0x20 || n === 0x7f || n > 0x7e
        ? `⟨${n.toString(16).padStart(2, "0")}⟩`
        : c;
    })
    .join("");
}

const files = generateBundleInputs();
console.error(`generated ${files.length} files from ${BUNDLE_PACKAGE}`);

const bundlers = {
  "esbuild (charset=ascii)": (input: Parameters<typeof bundleWithEsbuild>[0]) =>
    bundleWithEsbuild(input, "ascii"),
  "esbuild (charset=utf8)": (input: Parameters<typeof bundleWithEsbuild>[0]) =>
    bundleWithEsbuild(input, "utf8"),
  "rollup + terser": bundleWithRollup,
};

const sourceSizes = (pick: (content: string) => string) =>
  Object.fromEntries(
    ENCODINGS.map((e) => [
      e,
      sizes(
        new TextEncoder().encode(
          files.map((f) => pick(f.content[e])).join("\n"),
        ),
      ),
    ]),
  ) as Record<Encoding, Sizes>;
const source = {
  files: sourceSizes((content) => content),
  descriptors: sourceSizes(extractDescriptorExpr),
};

const results: Record<
  string,
  Record<
    Encoding,
    { bundle: Sizes; descriptors: Sizes; literals: Counts; sample: string }
  >
> = {};
for (const [bundler, bundle] of Object.entries(bundlers)) {
  results[bundler] = {} as (typeof results)[string];
  for (const encoding of ENCODINGS) {
    const full = await bundle(await writeBundleInput(files, encoding));
    const stub = await bundle(
      await writeBundleInput(files, encoding, { stub: true }),
    );
    const fullSizes = sizes(full);
    const stubSizes = sizes(stub);
    results[bundler][encoding] = {
      bundle: fullSizes,
      descriptors: {
        raw: fullSizes.raw - stubSizes.raw,
        gzip: fullSizes.gzip - stubSizes.gzip,
        brotli: fullSizes.brotli - stubSizes.brotli,
      },
      literals: diffCounts(
        count(new TextDecoder().decode(full)),
        count(new TextDecoder().decode(stub)),
      ),
      sample: sample(new TextDecoder().decode(full)),
    };
    console.error(bundler, encoding, fullSizes);
  }
}

const kb = (n: number) => (n / 1024).toFixed(1);
const ratio = (n: number, base: number) =>
  n === base
    ? ""
    : ` (${n > base ? "+" : ""}${(((n - base) / base) * 100).toFixed(0)}%)`;
const row = (label: string, s: Record<Encoding, Sizes>, key: keyof Sizes) =>
  `| ${label} | ${ENCODINGS.map((e) => `${kb(s[e][key])}${ratio(s[e][key], s.base64[key])}`).join(" | ")} |`;

const md: string[] = [
  "<!-- Generated by scripts/bundle-size.ts -->",
  "",
  `${files.length} generated files (\`${BUNDLE_PACKAGE}\` and its imports, googleapis@${GOOGLEAPIS_REV.slice(0, 12)}); esbuild ${esbuildVersion}, rollup ${rollupVersion}. Sizes in KiB.`,
  "",
  "#### Generated source (all files concatenated, before bundling)",
  "",
  `| | ${ENCODINGS.map((e) => LABELS[e]).join(" | ")} |`,
  `| --- | ${ENCODINGS.map(() => "---").join(" | ")} |`,
  ...(["raw", "gzip", "brotli"] as const).map((k) =>
    row(`files, ${k}`, source.files, k),
  ),
  ...(["raw", "gzip", "brotli"] as const).map((k) =>
    row(`\`fileDesc(…)\` only, ${k}`, source.descriptors, k),
  ),
];
for (const [bundler, r] of Object.entries(results)) {
  const pick = (part: "bundle" | "descriptors") =>
    Object.fromEntries(ENCODINGS.map((e) => [e, r[e][part]])) as Record<
      Encoding,
      Sizes
    >;
  md.push(
    "",
    `#### ${bundler}`,
    "",
    `| | ${ENCODINGS.map((e) => LABELS[e]).join(" | ")} |`,
    `| --- | ${ENCODINGS.map(() => "---").join(" | ")} |`,
    ...(["raw", "gzip", "brotli"] as const).map((k) =>
      row(`bundle, ${k}`, pick("bundle"), k),
    ),
    ...(["raw", "gzip", "brotli"] as const).map((k) =>
      row(`descriptors only, ${k}`, pick("descriptors"), k),
    ),
  );
}
md.push(
  "",
  "#### How the minifiers printed the descriptor literals",
  "",
  "Counts are taken over the whole bundle minus the stub bundle. In the sample, ⟨NN⟩ marks a raw (unescaped) character with that code.",
  "",
  '| bundler | encoding | `"…"+"…"` left | `\\xNN` | `\\uNNNN` | raw control chars | raw non-ASCII chars | backticks |',
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ...Object.entries(results).flatMap(([bundler, r]) =>
    ENCODINGS.map((e) => {
      const c = r[e].literals;
      return `| ${bundler} | ${LABELS[e]} | ${c.stringConcats} | ${c.hexEscapes} | ${c.unicodeEscapes} | ${c.rawControlChars} | ${c.rawNonAscii} | ${c.backticks} |`;
    }),
  ),
  "",
  "Samples (the start of `google/api/annotations.proto`'s descriptor):",
  "",
  "```",
  ...Object.entries(results).flatMap(([bundler, r]) =>
    ENCODINGS.map((e) => `${bundler} / ${LABELS[e]}: ${r[e].sample}`),
  ),
  "```",
);

mkdirSync(resultsDir, { recursive: true });
writeFileSync(join(resultsDir, "bundle-size.md"), `${md.join("\n")}\n`);
writeFileSync(
  join(resultsDir, "bundle-size.json"),
  `${JSON.stringify({ rev: GOOGLEAPIS_REV, package: BUNDLE_PACKAGE, files: files.length, source, results }, null, 2)}\n`,
);
console.log(md.join("\n"));
