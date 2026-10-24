# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm build          # TypeScript compilation (tsc)
pnpm test           # Run all tests (vitest run)
pnpm test:watch     # Run tests in watch mode
pnpm bench          # Benchmark the runtime against codegenv2
pnpm vitest run src/__tests__/transform.test.ts  # Run a single test file
```

Tests require `buf` to compile `.proto` files. The `@bufbuild/buf` devDependency provides it; tests run it with `process.execPath`.

## Architecture

This package is a **protoc-gen-es wrapper** that post-processes generated code so that git merges it safely: descriptors become length-less nested arrays, elements are referred to by name instead of by position, and a type keyed by number per message and enum turns duplicate numbers into TS2300 errors. See README for the generated shape.

### Transform pipeline

```
protocGenEs.run(request)        # Run original protoc-gen-es
  → response.file[].content     # Get generated code (.ts, .js, .d.ts)
  → transformFileContent()      # Post-process each file
    1. Decode fileDesc("base64", [deps]); replace oneof_index and public/weak
       dependencies with name markers (unknown fields) and drop synthetic
       oneofs (names.ts)
    2. Render the descriptor as a nested array (tree.ts) and check that it
       restores to the original bytes
    3. Rewrite messageDesc(file, 0, 1) & co to names
    4. Emit number types after fileDesc (.ts) or the GenFile declaration (.d.ts)
    5. Import fileDesc & co from this package instead of codegenv2
```

### Key modules

- **`plugin.ts`** — Wraps `protocGenEs`, maps each output file to its source proto for number types (none for `.js`)
- **`transform.ts`** — Rewrites one generated file
- **`tree.ts`** — `toTree` / `renderTree` (bytes → nested array literal) and `fromTree` (nested array → bytes with `BinaryWriter`)
- **`names.ts`** — `embedNames` / `restoreNames`: the name markers and synthetic oneofs, shared by plugin and runtime
- **`escape.ts`** — `escapeBytesAsJSString`: bytes→JS string literal escaping (like Go's `%q`); `jsStringToBytes`: reverse
- **`runtime.ts`** — `fileDesc` (nested array, or the raw byte string of 0.1) and name-or-path `messageDesc` / `enumDesc` / `serviceDesc` / `extDesc`. Exported from the package root
- **`bin.ts`** — CLI entry point using `runNodeJs(plugin)` for protoc integration

## Testing

- **Unit tests** (`tree.test.ts`, `names.test.ts`, `escape.test.ts`, `transform.test.ts`, `runtime.test.ts`): Direct function testing with no mocks.
- **Golden tests** (`golden/golden.test.ts`): `buf build` the protos in `golden/testdata` → run the plugin → compare with `toMatchFileSnapshot()` in `__snapshots__/`. Also evaluates the generated code next to protoc-gen-es output and compares every exported descriptor. Update snapshots with `pnpm vitest run -u`.
- **Merge tests** (`merge/merge.test.ts`): `git merge-file` generated code of the scenarios in `merge/scenarios/` and compare with regenerated code, or expect a `tsc` error when the merged `.proto` is invalid.
- **Number types** (`number-types.test.ts`): Type-check generated code with the `tsc` command line.
- Generated code that must resolve this repository's packages is written to `.tmp/` (gitignored). Vitest resolves `protoc-gen-es-string-descriptor` to `src/runtime.ts`.

## Conventions

- **ESM**: All imports use `.js` extension (`import { x } from "./module.js"`)
- **No mocks**: Tests use real protobuf libraries; golden tests compile actual `.proto` files
- **`@bufbuild/protoc-gen-es` has no module entry point**: Import from `@bufbuild/protoc-gen-es/dist/cjs/src/protoc-gen-es-plugin.js`
