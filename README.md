# protoc-gen-es-string-descriptor

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

## Installation

```bash
npm install protoc-gen-es-string-descriptor
# or
pnpm add protoc-gen-es-string-descriptor
```

### Peer dependencies

- `@bufbuild/protobuf` ^2.0.0

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

All `protoc-gen-es` options (e.g. `target=ts`, `target=js+dts`, `import_extension=none`) are passed through as-is.

## Runtime

Generated code imports `fileDesc` from `protoc-gen-es-string-descriptor/runtime` instead of `@bufbuild/protobuf/codegenv1`. This is a lightweight drop-in replacement that:

1. Converts raw byte string characters back to a `Uint8Array`
2. Base64-encodes and delegates to the original `fileDesc` from `@bufbuild/protobuf`

No additional runtime configuration is needed — just make sure `protoc-gen-es-string-descriptor` is installed as a dependency (not just devDependency) so the runtime import resolves.

## License

[MIT](LICENSE)
