# protoc-gen-es-string-descriptor

[![protoc-gen-es-string-descriptor Version](https://img.shields.io/npm/v/protoc-gen-es-string-descriptor?logo=npm&labelColor=313244&color=CB3837)](https://www.npmjs.com/package/protoc-gen-es-string-descriptor)
[![License](https://img.shields.io/github/license/izumin5210/protoc-gen-es-string-descriptor?labelColor=%23313244&color=%23a6e3a1)](./LICENSE)

A [protoc-gen-es](https://github.com/bufbuild/protobuf-es) wrapper that makes generated file descriptors **diff-friendly** by splitting them into multi-line raw byte string literals.

## Motivation

`protoc-gen-es` encodes `FileDescriptorProto` as a single base64 string. Even a small `.proto` change (e.g. renaming one field) regenerates the entire base64 blob, making diffs unreadable and code review painful.

**Before** (protoc-gen-es default):

```ts
export const file_simple: GenFile = /*@__PURE__*/
  fileDesc("CgxzaW1wbGUucHJvdG8SCHRlc3RkYXRhIjAKBFVzZXISDAoEbmFtZRgBIAEoCRILCgNhZ2UYAiABKAUSDQoFZW1haWwYAyABKAkqSAoGU3RhdHVzEhYKElNUQVRVU19VTlNQRUNJRklFRBAAEhEKDVNUQVRVU19BQ1RJVkUQARITCg9TVEFUVVNfSU5BQ1RJVkUQAmIGcHJvdG8z");
```

**After** (protoc-gen-es-string-descriptor):

```ts
export const file_simple: GenFile = /*@__PURE__*/
  fileDesc("" +
    "\n" +
    "\fsimple.proto\x12\btestdata\"0\n" +
    "\x04User\x12\f\n" +
    "\x04name\x18\x01 \x01(\t\x12\v\n" +
    "\x03age\x18\x02 \x01(\x05\x12\r\n" +
    "\x05email\x18\x03 \x01(\t*H\n" +
    "\x06Status\x12\x16\n" +
    "\x12STATUS_UNSPECIFIED\x10\x00\x12\x11\n" +
    "\rSTATUS_ACTIVE\x10\x01\x12\x13\n" +
    "\x0fSTATUS_INACTIVE\x10\x02b\x06proto3");
```

Each line roughly corresponds to a protobuf message boundary, so changes are localized to the proto elements that were actually modified.

This approach is ported from protoc-gen-go ([CL 657895](https://go-review.googlesource.com/c/protobuf/+/657895)).

## How it works

The serialized `FileDescriptorProto` bytes are split at `0x0a` boundaries. In protobuf wire format, `0x0a` = `(field_number=1 << 3) | wire_type=2(LEN)`. Since most descriptor messages have `string name = 1`, `0x0a` acts as a natural message boundary marker. Each chunk is then encoded as a JavaScript string literal and concatenated across multiple lines.

At runtime, a drop-in `fileDesc` replacement (exported from `protoc-gen-es-string-descriptor/runtime`) converts the raw byte strings back into the original binary and delegates to `@bufbuild/protobuf/codegenv1`.

## Index manifest

Generated code looks up every message, enum, service and extension by its position in the file descriptor:

```ts
export const TeamSchema: GenMessage<Team> = /*@__PURE__*/
  messageDesc(file_example, 1);
```

Once the descriptor merges cleanly, these positions can merge into wrong values without any conflict. For example, one branch inserts `Profile` before `Team`, so `TeamSchema` becomes `messageDesc(file_example, 2)`. Another branch appends `Invoice`, also at `messageDesc(file_example, 2)`. git merges both changes, and `InvoiceSchema` then silently points at `Team`.

To make such merges conflict, the plugin emits a manifest right after the `fileDesc(...)` statement, with one line per element that the generated code looks up by position:

```ts
// Index manifest: every descriptor that the generated code looks up by
// position (messageDesc, enumDesc, serviceDesc, extDesc), one block per
// list and one line per element as "<path>: <kind> <full name>". If two
// branches renumber the same list, these lines conflict instead of
// merging into silently wrong indices.
// top-level messages:
// 0: message example.v1.User
// 1: message example.v1.Profile
// 2: message example.v1.Team
// messages nested in example.v1.Profile:
// 1.0: message example.v1.Profile.Link
// enums nested in example.v1.Profile:
// 1.0: enum example.v1.Profile.Visibility
// services:
// 0: service example.v1.TeamService
```

How to read and maintain it:

- **Path**: the arguments that the generated `messageDesc` / `enumDesc` / `serviceDesc` / `extDesc` call receives after the file, joined by `.`. These are computed by `pathInFileDesc` from `@bufbuild/protobuf/codegenv2`, the same function protoc-gen-es uses. Map entry messages are not generated, so they are not listed and don't take up an index.
- **Blocks**: there is one block per list that generated code indexes into, and each list is numbered independently. A block starts with a header that names the list but not its position. Blocks come in this order:
  1. top-level messages;
  2. for every message, in declaration order, its nested messages, nested enums and nested extensions;
  3. top-level enums, services and top-level extensions.

  Empty lists have no block.
- **Why it conflicts**: inserting or removing an element renumbers every later element of the same list. Moving a message also changes the path of everything nested in it. When both branches change the same list, both rewrite the lines at its end, so `git merge` reports a conflict. When only one branch changes the list, the merge stays clean and that branch's numbers are correct.
- **Why the headers**: git also reports a conflict when two changes merely touch adjacent lines. The header between two blocks keeps edits at the end of one list and at the start of the next from conflicting with each other.
- **Opting out**: pass `index_manifest=false`, e.g. `opt: target=ts,index_manifest=false`.

The manifest makes these mistakes visible at merge time; it does not prove a merge correct. Keep a CI check that regenerates the code and fails on any diff, e.g. `buf generate && git diff --exit-code`.

## Installation

```bash
npm install -D protoc-gen-es-string-descriptor @bufbuild/protoc-gen-es
npm install @bufbuild/protobuf
# or
pnpm add -D protoc-gen-es-string-descriptor @bufbuild/protoc-gen-es
pnpm add @bufbuild/protobuf
```

## Setup

### With `buf.gen.yaml`

```diff
 version: v2
 plugins:
-  - local: protoc-gen-es
+  - local: protoc-gen-es-string-descriptor
     out: gen
     opt: target=ts
```

### With `protoc`

```bash
protoc \
  --plugin=protoc-gen-es-string-descriptor=./node_modules/.bin/protoc-gen-es-string-descriptor \
  --es-string-descriptor_out=gen \
  --es-string-descriptor_opt=target=ts \
  your.proto
```

All `protoc-gen-es` options (e.g. `target=ts`, `target=js+dts`, `import_extension=none`) are passed through as-is. The only option of this plugin, `index_manifest=false`, turns off the [index manifest](#index-manifest).

## Runtime

Generated code imports `fileDesc` from `protoc-gen-es-string-descriptor/runtime` instead of `@bufbuild/protobuf/codegenv1`. This is a lightweight drop-in replacement that:

1. Converts raw byte string characters back to a `Uint8Array`
2. Base64-encodes and delegates to the original `fileDesc` from `@bufbuild/protobuf`

No additional runtime configuration is needed — just make sure `protoc-gen-es-string-descriptor` is installed as a dependency (not just devDependency) so the runtime import resolves.

## License

[MIT](LICENSE)
