/**
 * Time how long it takes to hydrate every file descriptor of the bundled
 * googleapis package, per encoding.
 *
 * Usage: pnpm --filter demo load-bench [cold runs per encoding, default 30]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { base64Decode, base64Encode } from "@bufbuild/protobuf/wire";
import { Bench } from "tinybench";
import {
  BUNDLE_PACKAGE,
  bundleWithEsbuild,
  generateBundleInputs,
  writeBundleInput,
} from "../src/bundle.js";
import {
  extractDescriptorExpr,
  parseDescriptorArg,
} from "../src/descriptor-expr.js";
import { ENCODINGS, type Encoding } from "../src/generate.js";
import { GOOGLEAPIS_REV } from "../src/googleapis.js";
import { type DescTree, fromTree } from "../src/option-b/runtime.js";

const RUNS = Number(process.argv[2] ?? 30);
const resultsDir = join(import.meta.dirname, "..", "results");
const workDir = join(import.meta.dirname, "..", ".work", "load");

const files = generateBundleInputs();

// Cold: a fresh Node process imports a minified esbuild bundle. The bundle
// records timestamps before the first and after the last descriptor.
mkdirSync(workDir, { recursive: true });
// "direct" runtimes skip the base64 round trip that the shipped A/B runtimes
// take to reuse the stock `fileDesc`; base64 has nothing to skip.
const VARIANTS = [
  { name: "base64", encoding: "base64", direct: false },
  { name: "String literal (shipped runtime)", encoding: "a", direct: false },
  { name: "String literal (direct)", encoding: "a", direct: true },
  { name: "Nested array (shipped runtime)", encoding: "b", direct: false },
  { name: "Nested array (direct)", encoding: "b", direct: true },
  // Hydrates without a base64 round trip, so it compares with "direct".
  {
    name: "Nested array + names + number types",
    encoding: "b-names-numbers",
    direct: false,
  },
] as const;
const bundles: Record<string, string> = {};
for (const { name, encoding, direct } of VARIANTS) {
  const input = await writeBundleInput(files, encoding, {
    timing: true,
    direct,
  });
  bundles[name] = join(workDir, `${encoding}${direct ? "-direct" : ""}.mjs`);
  writeFileSync(bundles[name], await bundleWithEsbuild(input));
}

const probe = `
const t0 = performance.now();
const { files } = await import(process.argv[1]);
const t1 = performance.now();
if (files.length === 0) throw new Error("no files");
console.log(JSON.stringify({
  import: t1 - t0,
  hydrate: globalThis.hydrateEnd - globalThis.hydrateStart,
}));
`;
const cold = Object.fromEntries(
  VARIANTS.map((v) => [
    v.name,
    { import: [] as number[], hydrate: [] as number[] },
  ]),
) as Record<string, { import: number[]; hydrate: number[] }>;
for (let i = 0; i < RUNS; i++) {
  // Interleave variants so that machine noise hits all of them alike.
  for (const { name } of VARIANTS) {
    const out = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", probe, pathToFileURL(bundles[name]).href],
      { encoding: "utf8" },
    );
    const sample = JSON.parse(out) as { import: number; hydrate: number };
    cold[name].import.push(sample.import);
    cold[name].hydrate.push(sample.hydrate);
  }
}

// Warm: only the step that differs between encodings, i.e. turning the
// literal into descriptor bytes, on the same inputs.
const args = Object.fromEntries(
  ENCODINGS.map((e) => [
    e,
    files.map((f) =>
      parseDescriptorArg(extractDescriptorExpr(f.content[e]), e),
    ),
  ]),
) as Record<Encoding, (string | DescTree)[]>;

function rawToBytes(raw: string): Uint8Array {
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}

const bench = new Bench({ time: 1000, warmup: true });
bench
  .add("base64: base64Decode", () => {
    for (const s of args.base64) base64Decode(s as string);
  })
  .add("String literal: chars to bytes", () => {
    for (const s of args.a) rawToBytes(s as string);
  })
  .add("String literal: as shipped (+ base64 round trip)", () => {
    for (const s of args.a)
      base64Decode(base64Encode(rawToBytes(s as string), "std_raw"));
  })
  .add("Nested array: fromTree", () => {
    for (const t of args.b) fromTree(t as DescTree);
  })
  .add("Nested array: as shipped (+ base64 round trip)", () => {
    for (const t of args.b)
      base64Decode(base64Encode(fromTree(t as DescTree), "std_raw"));
  });
await bench.run();

const median = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const p90 = (xs: number[]) =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.9)];
const ms = (n: number) => n.toFixed(2);

const env = {
  node: process.version,
  v8: process.versions.v8,
  nativeFromBase64:
    typeof (Uint8Array as unknown as { fromBase64?: unknown }).fromBase64 ===
    "function",
  platform: `${process.platform}/${process.arch}`,
};
const md = [
  "<!-- Generated by scripts/load-bench.ts -->",
  "",
  `${files.length} files (\`${BUNDLE_PACKAGE}\` and its imports, googleapis@${GOOGLEAPIS_REV.slice(0, 12)}). Node ${env.node} (V8 ${env.v8}), ${env.platform}; \`Uint8Array.fromBase64\` available: ${env.nativeFromBase64}.`,
  "",
  `#### Cold: fresh process imports the minified esbuild bundle (${RUNS} runs, ms)`,
  "",
  "| | import median | import p90 | hydrate median | hydrate p90 |",
  "| --- | --- | --- | --- | --- |",
  ...VARIANTS.map(
    ({ name }) =>
      `| ${name} | ${ms(median(cold[name].import))} | ${ms(p90(cold[name].import))} | ${ms(median(cold[name].hydrate))} | ${ms(p90(cold[name].hydrate))} |`,
  ),
  "",
  "#### Warm: literal to descriptor bytes for all files (tinybench, ms per iteration)",
  "",
  "| | mean | p99 | samples |",
  "| --- | --- | --- | --- |",
  ...bench.tasks.map((t) => {
    const r = t.result as {
      latency?: { mean: number; p99: number; samplesCount: number };
    };
    return `| ${t.name} | ${ms(r.latency?.mean ?? Number.NaN)} | ${ms(r.latency?.p99 ?? Number.NaN)} | ${r.latency?.samplesCount ?? 0} |`;
  }),
];

mkdirSync(resultsDir, { recursive: true });
writeFileSync(join(resultsDir, "load-bench.md"), `${md.join("\n")}\n`);
writeFileSync(
  join(resultsDir, "load-bench.json"),
  `${JSON.stringify({ env, runs: RUNS, cold, warm: bench.table() }, null, 2)}\n`,
);
console.log(md.join("\n"));
