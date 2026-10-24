# protoc-gen-es-string-descriptor

[![protoc-gen-es-string-descriptor Version](https://img.shields.io/npm/v/protoc-gen-es-string-descriptor?logo=npm&labelColor=313244&color=CB3837)](https://www.npmjs.com/package/protoc-gen-es-string-descriptor)
[![License](https://img.shields.io/github/license/izumin5210/protoc-gen-es-string-descriptor?labelColor=%23313244&color=%23a6e3a1)](./LICENSE)

A [protoc-gen-es](https://github.com/bufbuild/protobuf-es) wrapper that embeds file descriptors in a form that git can **merge safely**: when two branches change the same `.proto` file in unrelated places, the generated code merges cleanly and correctly, and when the merged `.proto` would be invalid, the merged code fails type checking.

## Motivation

`protoc-gen-es` embeds each `FileDescriptorProto` as a single base64 string. Any change to a `.proto` file rewrites that line, so two branches that touch unrelated parts of the same file always conflict in the generated code, even when the `.proto` files merge cleanly.

Splitting the descriptor over many lines makes diffs readable, but then git merges more changes cleanly, and some of those clean merges are wrong without any error. Descriptors and generated code refer to elements by **position**:

- **Length prefixes.** Every nested element carries the byte length of its content. If both sides grow the same message by the same number of bytes, git sees identical changes to the length and merges them. Part of the content then falls outside the message, and a field silently disappears.
- **Positional references.** `messageDesc(file, 2)` and likewise `enumDesc`, `serviceDesc` and `extDesc` look elements up by index. If one side inserts a message and the other appends one, the appended message's index is stale after the merge and its schema points at a different message. Inside the descriptor, `oneof_index` (including the synthetic oneofs of proto3 `optional` fields), `public_dependency` and `weak_dependency` shift the same way.
- **Duplicates.** If both sides add a field with number 3 at different places, the merged `.proto` no longer compiles, but the merged generated code loads a message with two fields numbered 3.

This plugin removes the length prefixes and the positional references, and turns duplicate numbers into type errors.

**Before** (protoc-gen-es):

```ts
export const file_simple: GenFile = /*@__PURE__*/
  fileDesc("CgxzaW1wbGUucHJvdG8SCHRlc3RkYXRhIjAKBFVzZXISDAoEbmFtZRgBIAEoCRILCgNhZ2UYAiABKAUSDQoFZW1haWwYAyABKAliBnByb3RvMw");

export const UserSchema: GenMessage<User> = /*@__PURE__*/
  messageDesc(file_simple, 0);
```

**After** (protoc-gen-es-string-descriptor):

```ts
export const file_simple: GenFile = /*@__PURE__*/
  fileDesc([
 "\n\fsimple.proto",
 "\x12\btestdata",
 ["\"", [
  "\n\x04User",
  ["\x12", [
   "\n\x04name",
   "\x18\x01 \x01(\t",
  ]],
  ["\x12", [
   "\n\x03age",
   "\x18\x02 \x01(\x05",
  ]],
  ["\x12", [
   "\n\x05email",
   "\x18\x03 \x01(\t",
  ]],
 ]],
 "b\x06proto3",
], [
], [
]);
export type _numbers_testdata_User = {
  1: "name";
  2: "age";
  3: "email";
};

export const UserSchema: GenMessage<User> = /*@__PURE__*/
  messageDesc(file_simple, "User");
```

## How it works

The plugin runs protoc-gen-es and rewrites its output.

1. **The descriptor is a nested array without length prefixes.** The schema of `descriptor.proto` tells which fields are sub-messages (messages, fields, enums, options, …). Each becomes `[tag, [children]]`; everything else stays raw wire bytes in a string literal. Each string or bytes field is on its own line, consecutive numbers share one, every level is indented by one space, and every element has a trailing comma. The runtime recomputes the lengths.
2. **Elements are referred to by name.**
   - `messageDesc(file, "Outer.Inner")` instead of `messageDesc(file, 0, 0)`, and likewise for `enumDesc`, `serviceDesc` and `extDesc`. Names are relative to the package. Map entries are not counted, as in protobuf-es.
   - Synthetic oneofs of proto3 `optional` fields are left out and re-created on load, named the way protoc names them.
   - Members of real oneofs are listed as `["oneof", "Message.field", "oneofName"]` instead of `oneof_index`.
   - Public and weak imports are listed as `["public", file_dep]` / `["weak", file_dep]` instead of `public_dependency` / `weak_dependency`.
3. **Imports are listed one per line.** With names in place, their order no longer matters.
4. **A type keyed by number is emitted per message and enum**, e.g. `_numbers_testdata_User` above. If a merge produces two fields or enum values with the same number, TypeScript reports `TS2300: Duplicate identifier '3'`. The types are emitted in `.ts` and `.d.ts` files, but not in `.js` files, and they are exported so that `noUnusedLocals` accepts them. Enums with `allow_alias` are left out.

`fileDesc`, `messageDesc`, `enumDesc`, `serviceDesc` and `extDesc` are imported from this package instead of `@bufbuild/protobuf/codegenv2`. Other imports, such as `tsEnum`, stay as they are.

The plugin restores every descriptor it emits the way the runtime will, and fails if the result differs from what protoc-gen-es embeds.

### `fileDesc(tree, imports, names)`

All three arguments are always emitted, each spread over lines, so that adding the first import or the first name entry does not touch the same line as other changes.

| Argument | Contents |
| --- | --- |
| `tree` | The `FileDescriptorProto` as protoc-gen-es embeds it, without length prefixes, synthetic oneofs, `oneof_index`, `public_dependency` and `weak_dependency`. Each string is wire bytes, one character per byte; each `[tag, [children]]` pair is a sub-message. |
| `imports` | The imported files, in import order, as in protoc-gen-es output. |
| `names` | `["oneof", "Message.field", "oneofName"]` for each member of a real oneof, and `["public", file]` / `["weak", file]` for public and weak imports. |

## Installation

```bash
npm install -D protoc-gen-es-string-descriptor @bufbuild/protoc-gen-es
npm install protoc-gen-es-string-descriptor @bufbuild/protobuf
# or
pnpm add -D @bufbuild/protoc-gen-es
pnpm add protoc-gen-es-string-descriptor @bufbuild/protobuf
```

`@bufbuild/protobuf` and `@bufbuild/protoc-gen-es` 2.5.0 or later are required.

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

All `protoc-gen-es` options (e.g. `target=ts`, `target=js+dts`, `import_extension=js`) are passed through as-is.

## Runtime

Generated code imports the runtime from the package root, so install `protoc-gen-es-string-descriptor` as a dependency, not only as a devDependency.

- `fileDesc(tree, imports, names)` rebuilds the descriptor bytes with `BinaryWriter`, restores the name table and the synthetic oneofs, and hydrates the file as `fileDesc` from `@bufbuild/protobuf/codegenv2` does. It also accepts the raw byte string that earlier versions of this plugin generated.
- `messageDesc`, `enumDesc`, `serviceDesc` and `extDesc` take a name relative to the package, or the path that their codegenv2 counterparts take. Names are looked up in a map that is built per file on first use; paths are passed to codegenv2. They return the same generic types (`GenMessage`, `GenEnum`, `GenService`, `GenExtension`) as codegenv2.

For a 105 KB descriptor with 300 messages, hydrating takes about 2–3 ms (roughly 20%) longer than codegenv2's `fileDesc` with base64, almost all of it for rebuilding the bytes. Looking up all 300 messages by name, including building the map, takes about 0.2 ms, compared with 0.1 ms by path. Run `pnpm bench` to reproduce.

## Migrating from 0.1

- Regenerate all code and upgrade the runtime at the same time. Code generated by this version needs this version of the runtime.
- Code generated by 0.1 keeps working with the new runtime, so the runtime can be upgraded first.
- Every generated file changes once.

## Limitations

- Number types only catch duplicate numbers if the generated code is type-checked. With `target=js+dts` they are in `.d.ts` files, which `skipLibCheck: true` skips.
- If one branch adds a map field and another adds a nested message to the same message, the generated code still conflicts: map entries are nested messages in the descriptor, so the two additions end up next to each other.
- Fewer conflicts do not make generated code a source of truth. CI should still regenerate the code and check that it matches.

## License

[MIT](LICENSE)
