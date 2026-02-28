# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm build          # TypeScript compilation (tsc)
pnpm test           # Run all tests (vitest run)
pnpm test:watch     # Run tests in watch mode
pnpm vitest run src/__tests__/split.test.ts  # Run a single test file
```

Golden tests require `buf` to compile `.proto` files into binary descriptors. The `@bufbuild/buf` devDependency provides this — run via `pnpm buf`.

## Architecture

This package is a **protoc-gen-es wrapper** that post-processes generated code to make file descriptors diff-friendly. It applies the same algorithm as protoc-gen-go ([CL 657895](https://go-review.googlesource.com/c/protobuf/+/657895)): splitting serialized `FileDescriptorProto` bytes at `0x0a` boundaries and encoding each chunk as a JS string literal.

### Transform pipeline

```
protocGenEs.run(request)        # Run original protoc-gen-es
  → response.file[].content     # Get generated TypeScript code
  → transformFileContent()      # Post-process each file
    1. Regex-match fileDesc("base64...") calls
    2. base64Decode → splitAfter(bytes, 0x0a) → escapeBytesAsJSString per chunk
    3. Replace single-line base64 with multi-line raw byte string concatenation
    4. Rewrite import { fileDesc } to point to our runtime package
```

### Key modules

- **`plugin.ts`** — Wraps `protocGenEs` from `@bufbuild/protoc-gen-es`, applies `transformFileContent` to each response file
- **`transform.ts`** — Orchestrates the base64→raw-string conversion and import rewriting
- **`split.ts`** — `splitAfter(bytes, separator)`: equivalent to Go's `bytes.SplitAfter`
- **`escape.ts`** — `escapeBytesAsJSString`: bytes→JS string literal escaping (like Go's `%q`); `jsStringToBytes`: reverse
- **`runtime.ts`** — Drop-in `fileDesc` replacement that accepts raw byte strings instead of base64. Exported as `protoc-gen-es-string-descriptor/runtime` subpath
- **`bin.ts`** — CLI entry point using `runNodeJs(plugin)` for protoc integration

### Why `0x0a`?

In protobuf wire format, `0x0a` = `(field_number=1 << 3) | wire_type=2(LEN)`. Most protobuf descriptor messages have `string name = 1`, so `0x0a` acts as a natural message boundary marker. Splitting here localizes diffs to the proto elements that actually changed.

## Testing

- **Unit tests** (`split.test.ts`, `escape.test.ts`, `transform.test.ts`): Direct function testing with no mocks. `transform.test.ts` includes byte-level round-trip correctness verification.
- **Golden tests** (`golden/golden.test.ts`): Compiles `.proto` files via `buf build` → constructs `CodeGeneratorRequest` → runs `plugin.run()` → compares output with `toMatchFileSnapshot()`. Snapshot files live in `__snapshots__/`. Update snapshots with `pnpm vitest run -u`.

## Conventions

- **ESM**: All imports use `.js` extension (`import { x } from "./module.js"`)
- **No mocks**: Tests use real protobuf libraries; golden tests compile actual `.proto` files
- **`@bufbuild/protoc-gen-es` has no module entry point**: Import from `@bufbuild/protoc-gen-es/dist/cjs/src/protoc-gen-es-plugin.js`
