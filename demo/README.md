# Merge-friendly file descriptors: conflict replay and bundle-size benchmark

This directory holds the evidence for a feature request to
[protobuf-es](https://github.com/bufbuild/protobuf-es): embed file descriptors
in a form that survives concurrent edits. It is not part of the published
package.

**Proposal: Option B + manifest.**

- **Option B** embeds the descriptor as nested arrays without length
  prefixes.
- **The manifest** is a comment block that lists, one line each, every
  position that the generated code or the embedded descriptor refers to:
  - messages, enums, services and extensions, for `messageDesc(file, 2)` & co;
  - imports, for `public_dependency` / `weak_dependency`;
  - the oneofs of each message, for `oneof_index`.

**Summary**

- Today, base64 conflicts on every concurrent change. In 46 pairs of real
  googleapis commits where both sides changed the same descriptor, base64
  conflicted in **all 46**; B + manifest merged **35** cleanly and correctly.
- **B + manifest never merged into a wrong result**, neither in the replay
  nor in a synthetic matrix of 8,272 edit pairs over every list that is
  referenced by position. Every other variant did. The manifest cost 4
  correct merges in the matrix, all adjacent edits to the import list.
- **Option A** (this package: raw byte strings split after `0x0a`) has a
  failure mode that no manifest can catch. If both sides grow the same
  message, enum or service by the same number of bytes, its length prefix
  changes identically on both sides, and git merges it. Part of the merged
  content then falls outside the container. protobuf-es loads the result
  without an error, and a field silently disappears.
- Both encodings are smaller than base64 once minified and compressed: the
  descriptors in a real esbuild bundle are **−33% (A) / −37% (B) gzip**,
  for a few milliseconds of hydration time.
- A clean merge is still not proof of correctness, so CI should regenerate
  and compare.

| variant | replay: whole `_pb.ts` clean and correct | replay: conflict | replay: clean but wrong | matrix: clean but wrong | matrix: cost | bundle gzip (descriptors) | cold hydrate (median) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| base64 (protoc-gen-es) | 0 / 46 | 46 | 0 | 0 | — | 115.7 KiB | 97.7 ms |
| Option A | 29 | 15 | 2 | 91 | — | 77.9 KiB | 106.8 ms (94.5 ms direct) |
| Option A + manifest | 29 | 17 | 0 | **18** | 0 | ≈ A | ≈ A |
| Option B | 35 | 7 | 4 | 180 | — | 72.9 KiB | 109.3 ms (97.6 ms direct) |
| Option B + manifest | 35 | 11 | **0** | **0** | 4 | ≈ B | ≈ B |

"Cost" counts correct clean merges that the manifest turns into conflicts.
The manifest is comments only, and minifiers drop it, so sizes and load
times were not re-measured for it. Everything uses public data only:
[googleapis/googleapis](https://github.com/googleapis/googleapis) at
`4792db7b61d0`, plus the small hand-written protos in `conflict-demo/`.

## The encodings

All three embed the same bytes. protoc-gen-es strips `dependency`,
`source_code_info` and derivable `json_name`s and serializes the result. The
demo always starts from real protoc-gen-es output and rewrites it, so the
stripping is exactly upstream's.

```ts
// base64: one line per file
fileDesc("ChhleGFtcGxlL3YxL2xpYnJhcnkucHJvdG8SCmV4YW1wbGUudjEiRwoEQm9vaxIM…");

// Option A: raw bytes, split after every 0x0a (as protoc-gen-go does)
fileDesc("" +
    "\n" +
    "\x18example/v1/library.proto\x12\n" +
    "example.v1\"G\n" +
    "\x04Book\x12\f\n" +
    "\x04name\x18\x01 \x01(\t\x12\r\n" +
    …);

// Option B: sub-messages become [tag, children]; their lengths are dropped
fileDesc([
 "\n\x18example/v1/library.proto",
 "\x12\nexample.v1",
 ["\"", [
  "\n\x04Book",
  ["\x12", ["\n\x04name\x18\x01 \x01(\t"]],
  ["\x12", ["\n\x05title\x18\x02 \x01(\t"]],
 ]],
 …
]);
```

Option A still contains each message's length prefix (`"G` above is
`message_type`, 71 bytes). Any edit inside a message changes the length of
every ancestor, and the line holding that length conflicts with any other
edit in the same ancestor.

Option B removes those lengths:

- The generator walks the wire format with `BinaryReader`. It uses
  `FileDescriptorProtoSchema` to decide which LEN fields are sub-messages,
  and emits `[tag, children]` for them.
- Everything else stays as raw byte strings, including unknown fields such as
  option extensions. A LEN field starts a new line, and the scalars that
  follow it stay on that line.
- There is one space of indentation per level and a trailing comma on every
  element, so an append never touches the previous line.
- The runtime needs no schema. It measures each subtree, writes
  `tag + varint(length) + body` into one buffer, and hands the bytes to the
  stock hydration.

Code: [`src/option-b/encode.ts`](src/option-b/encode.ts),
[`src/option-b/runtime.ts`](src/option-b/runtime.ts),
[`src/option-b/transform.ts`](src/option-b/transform.ts) (rewrites
protoc-gen-es output, like [`../src/transform.ts`](../src/transform.ts) does
for A).

## The manifest

Generated code and the embedded descriptor both refer to elements by
position. When two branches renumber the same list, git can merge both
renumberings into silently wrong positions. The manifest lists every such
list, so that renumbering it on both sides conflicts instead.

It is a comment block right after the `fileDesc(…)` statement, with one
block per list and one line per element:

```ts
// Index manifest: every position that the generated code or the embedded
// descriptor refers to, one block per list and one line per element. If
// two branches renumber the same list, these lines conflict instead of
// merging into silently wrong indices.
// imports:
// 0: google/protobuf/descriptor.proto
// 1: dep/b.proto (public)
// top-level messages:
// 0: message example.v1.User
// 1: message example.v1.Profile
// messages nested in example.v1.Profile:
// 1.0: message example.v1.Profile.Link
// oneofs of example.v1.User:
// 0: _nickname
// 1: _email
// services:
// 0: service example.v1.TeamService
```

- **Paths** of messages, enums, services and extensions are the arguments
  that generated code passes after the file, e.g. `messageDesc(file, 1, 0)`.
  They come from `pathInFileDesc` in `@bufbuild/protobuf/codegenv2`.
- **Imports** are listed in the order that protobuf-es rebuilds `dependency`
  in, from the `imports` array of `fileDesc`. Public and weak imports are
  marked, because `public_dependency` and `weak_dependency` index into that
  list.
- **Oneofs** are each message's `oneof_decl`, synthetic oneofs of proto3
  `optional` fields included, because `oneof_index` indexes into it.
- **Why it conflicts.** Inserting or removing an element renumbers every
  later element of its list, and moving a message renumbers the paths of
  everything nested in it. When both sides do that to the same list, both
  rewrite the end of its block.
- **Why the header lines.** git also conflicts on changes that merely touch
  adjacent lines. A header line between two blocks keeps edits at the end
  of one list and at the start of the next from conflicting.

[`src/manifest.ts`](src/manifest.ts) builds it. The "index manifest"
variant lists only the generated-code references; that part is also
proposed as a feature of this wrapper.

### Which descriptor fields are positions

Every integer field reachable from `FileDescriptorProto`, plus the
references by name:

| field | refers to | in the embedded descriptor | covered by |
| --- | --- | --- | --- |
| `FileDescriptorProto.public_dependency` | position in `dependency` | yes | `imports` block (marked `public`) |
| `FileDescriptorProto.weak_dependency` | position in `dependency` | yes | `imports` block (marked `weak`) |
| `FieldDescriptorProto.oneof_index` | position in the message's `oneof_decl` | yes | `oneofs of …` block |
| `SourceCodeInfo.Location.path`, `.span` | positions | no, protoc-gen-es strips `source_code_info` | — |
| `FileDescriptorProto.dependency` | file names | no, stripped and rebuilt from `fileDesc`'s `imports` array | the array is on one line, so both sides changing imports conflicts there |
| `FileDescriptorProto.option_dependency` | file names | yes | names, not positions |
| field and enum value numbers, reserved and extension range bounds, `ExtensionRangeOptions.Declaration.number`, `UninterpretedOption` values | values | yes | values, not positions |
| `type_name`, `extendee`, `input_type`, `output_type` | fully-qualified names | yes | names, not positions |

A name reference can still go stale: one side renames a message while the
other adds a field of that type. But then the merged `.proto` does not
compile either, so regenerating catches it.

`oneof_index` is not harmless. protobuf-es ignores it for proto3 `optional`
fields (`findOneof` in `@bufbuild/protobuf` 2.11.0's `registry.js`), so the
runtime behaves the same. But the descriptor itself changes meaning, and
protobuf-go rejects it: `proto: message field "example.v1.User.email" under
proto3 optional semantics must be within a single element oneof`. Anything
that reads `file.proto`, e.g. gRPC server reflection, passes the broken
descriptor on.

## Readable demo: what conflicts and why

`conflict-demo/` has nine pairs of edits. Every pair merges cleanly as
`.proto`. The script generates every variant for base, ours and theirs,
runs `git merge-file`, and compares each clean result with the code
generated from the merged `.proto`. Wrong descriptors are also loaded with
protobuf-es and with protobuf-go's `protodesc.NewFiles`.

Whole generated `_pb.ts`:

| scenario | base64 | A | A + manifest | B | B + index manifest | B + manifest |
| --- | --- | --- | --- | --- | --- | --- |
| same service, different RPCs added | conflict | conflict | conflict | clean | clean | clean |
| same message, different fields added | conflict | conflict | conflict | clean | clean | clean |
| message inserted right before a message the other side changed | conflict | conflict | conflict | clean | clean | clean |
| control: different messages changed | conflict | clean | clean | clean | clean | clean |
| `Profile` inserted before `Team` / `Invoice` appended | conflict | **wrong** (code) | conflict | **wrong** (code) | conflict | conflict |
| optional `bio` inserted / optional `phone` appended right after | conflict | conflict | conflict | conflict | conflict | conflict |
| the same, with a plain field between `email` and `phone` | conflict | conflict | conflict | **wrong** (Go rejects) | **wrong** (Go rejects) | conflict |
| `bio` inserted / `age` appended, same byte size | conflict | **wrong** (Go rejects) | **wrong** (Go rejects) | clean | clean | clean |
| import made public / import inserted before it | conflict | conflict | conflict | **wrong** (Go accepts) | **wrong** (Go accepts) | conflict |

Every "clean" result above is byte-identical to the regenerated file.

**Index shift in generated code.** Both descriptors merge correctly, but
`InvoiceSchema` keeps theirs' `messageDesc(file, 2)` although ours moved
`Team` to 2:

```diff
# merged without the manifest (- expected, + merged)
 export const InvoiceSchema: GenMessage<Invoice> = /*@__PURE__*/
-  messageDesc(file_example_v1_library, 3);
+  messageDesc(file_example_v1_library, 2);
```

**`oneof_index`.** If `phone` is appended right after `email`, B conflicts
anyway: ours rewrites `email`'s line (its `oneof_index` moves from 1 to 2),
and theirs inserts directly below it. With one plain field in between, B
merges, and `phone` keeps `oneof_index` 2, which is now `_email`. protobuf-es
loads it unchanged; protobuf-go rejects it. The oneofs block conflicts:

```js
<<<<<<< ours
// 1: _bio
// 2: _email
=======
// 1: _email
// 2: _phone
>>>>>>> theirs
```

**`public_dependency`.** Ours makes `dep/b.proto` public
(`public_dependency` = 1). Theirs inserts `dep/c.proto` first, so `b` moves
to 2. Only theirs changes the `imports` array, so B merges, and
`public_dependency` now points at `dep/a.proto`. Both protobuf-es and
protobuf-go accept it. The imports block conflicts.

**Option A, same-size edits to one message.** Ours inserts `string bio = 4;`
after `id`, theirs appends `string age = 5;`. Both grow `User` by 13 bytes,
so both rewrite its length prefix to the same value, and git keeps it once:

```diff
# merged Option A (- expected, + merged)
-    "example.v1\"I\n" +
+    "example.v1\"<\n" +
```

`User` now ends before `age`, whose bytes are parsed as the file's
`package`. protobuf-es loads the file without an error:

```diff
-message "example.v1.User" { id = 1; bio = 4; name = 2; email = 3; age = 5 }
+message "\n\u0003age\u0018\u0005 \u0001(\t.User" { id = 1; bio = 4; name = 2; email = 3 }
```

`toJsonString(create(UserSchema, { id: "1", age: "20" }))`, with
`UserSchema` = `messageDesc(file, 0)` as in generated code, gives
`{"id":"1"}`: `age` is silently dropped. protobuf-go rejects the descriptor
(`invalid package`). No index moved, so the manifest cannot see it. Option B
has no length prefixes and merges this case correctly.

All hunks and diffs: [`results/conflict-demo.md`](results/conflict-demo.md).

## Replay on googleapis history

**Method.** Three large, frequently edited files were used:
`google/container/v1/cluster_service.proto`, `google/pubsub/v1/pubsub.proto`
and `google/cloud/deploy/v1/cloud_deploy.proto`. For the last 40 consecutive
commit pairs (C1, C2) touching each file:

1. base = C1^, ours = C1, theirs = C2's own diff applied to C1^
   (`git merge-file -p <C1^> <C2^> <C2>`). Skip the pair if that conflicts.
2. Merge the `.proto` (`git merge-file ours base theirs`). If it conflicts,
   count it as a semantic conflict and skip it. This happened 0 times, because
   C2 already rebased cleanly onto C1^.
3. `buf build --exclude-source-info` each side. All four sides use C2's
   imports, so only the replayed file differs between them.
4. Run protoc-gen-es, derive every variant, and merge two things with
   `git merge-file`: the `fileDesc(…)` expression alone, and the whole
   generated `_pb.ts`.
5. For every clean merge, decode the result and compare it with the
   descriptor built from the merged `.proto`. For the whole file, compare it
   with the file generated from the merged `.proto`. Wrong descriptors are
   also loaded with protobuf-go's `protodesc.NewFiles`.

**Results.** Of 115 pairs, 30 did not rebase and 85 were replayed. In 39 of
those, one side did not change the descriptor (e.g. a comment-only commit),
and every variant merges trivially. The other 46 pairs:

| variant | `fileDesc(…)`: clean | conflict | clean but wrong | whole `_pb.ts`: clean | conflict | clean but wrong |
| --- | --- | --- | --- | --- | --- | --- |
| base64 | 0 | 46 | 0 | 0 | 46 | 0 |
| Option A | 33 | 13 | 0 | 29 | 15 | 2 |
| Option A + manifest | 33 | 13 | 0 | 29 | 17 | 0 |
| Option B | 44 | 1 | 1 | 35 | 7 | 4 |
| Option B + index manifest | 44 | 1 | 1 | 35 | 10 | 1 |
| Option B + manifest | 44 | 1 | 1 | 35 | 11 | **0** |

The manifest variants embed the same descriptor as their encoding, so the
`fileDesc(…)` columns are the same; the manifest acts on the whole file.

- **The manifest turned every wrong whole-file merge into a conflict:** 2
  with A, 4 with B. Its cost was 0: no correct merge became a conflict.
- **B's 4 wrong merges** are 3 index shifts in generated code and 1
  `oneof_index` (cluster_service `f0a78c77d2` / `449133156d`: both sides
  added a proto3 `optional` field to `ClusterUpdate`). protobuf-go rejects
  the latter. The index manifest catches the 3 shifts; the oneofs block
  catches the last one.
- **B's one descriptor conflict:** both sides added a top-level message at
  the same place (pubsub `69e9dff10d` / `d992b0619e`). In the `.proto`, the
  insertions were separated by comments, which the descriptor does not
  have.

Per-file tables: [`results/replay/summary.md`](results/replay/summary.md).
Per-pair records with commit SHAs: [`results/replay/`](results/replay/).

## Synthetic matrix

Real history covers only some patterns, so
[`scripts/shift-matrix.ts`](scripts/shift-matrix.ts) applies every pair of
single edits to a small schema. Its lists have 3 elements each:

- what generated code indexes into: top-level and nested messages, enums
  and extensions, and services;
- imports (none public at first);
- the values of an enum and the methods of a service.

It also has 9 fields of one message (plain, proto3 `optional` and real
oneof fields, interleaved).

Each side inserts at the front, in the middle or at the end, or deletes the
first or the last element. Fields are added and deleted per kind, and an
import can also be made public. Every ordered pair runs twice: with both
sides adding elements of the same byte size, and of different sizes. Of
8,712 pairs, 440 conflict as `.proto` and are excluded. The whole
`_pb.ts` is compared with the file generated from the merged schema.

| variant | clean | conflict | clean but wrong: generated code | wrong descriptor, protobuf-go rejects | wrong descriptor, protobuf-go accepts |
| --- | --- | --- | --- | --- | --- |
| base64 | 0 | 8,272 | 0 | 0 | 0 |
| Option A | 5,848 | 2,333 | 55 | 30 | 6 |
| Option A + manifest | 5,848 | 2,406 | 0 | 18 | 0 |
| Option B | 7,588 | 504 | 148 | 28 | 4 |
| Option B + index manifest | 7,588 | 652 | 0 | 28 | 4 |
| Option B + manifest | 7,584 | 688 | **0** | **0** | **0** |

- **B + manifest: 0 clean-but-wrong.**
  - The 148 index shifts in generated code are caught by the index
    manifest.
  - The 28 `oneof_index` cases are caught by the oneofs blocks.
  - The 4 `public_dependency` cases are caught by the imports block.
  - Its cost is 4 correct merges turned into conflicts. In each, one side
    deletes the last import and the other marks the import above it public;
    the two manifest lines are adjacent.
- **A + manifest: 18 clean-but-wrong, all undetectable by a manifest.** They
  are same-size edits on both sides of one container: 6 field lists, 6
  enum value lists, 6 method lists.
  - The orphaned bytes are parsed as the file's `package`. protobuf-go
    rejects the result; protobuf-es does not.
  - A's 6 same-size cases on nested messages are worse: the orphaned
    message is parsed as a `dependency`, which `fileDesc` overwrites, and
    protobuf-go accepts it. The manifest catches those, though, because
    nested indices also shift.
- **B's 36 different-list cases** move a parent message while the other side
  appends to its nested messages, enums or extensions. The new reference
  keeps the parent's old index. A conflicts on these anyway because of
  length prefixes.

Details: [`results/shift-matrix.md`](results/shift-matrix.md). Every pair
where a variant is clean but wrong or a manifest changes the outcome:
[`results/shift-matrix.tsv`](results/shift-matrix.tsv).

## Bundle size with real bundlers

**Method.** TypeScript was generated for `google/cloud/aiplatform/v1` and its
imports (137 files, well-known types excluded) in all three encodings. An
entry imports every `file_*` export so that nothing is tree-shaken. It was
bundled with esbuild `--bundle --minify` (0.28.2) and with Rollup 4.65 +
terser. "Descriptors only" is the full bundle minus a bundle whose
descriptors are emptied. Sizes in KiB, gzip level 9, brotli quality 11.

| esbuild, charset=ascii | base64 | Option A | Option B |
| --- | --- | --- | --- |
| bundle, raw | 578.0 | 478.5 (−17%) | 572.3 (−1%) |
| bundle, gzip | 134.2 | 96.6 (−28%) | 91.7 (−32%) |
| bundle, brotli | 104.5 | 77.4 (−26%) | 72.5 (−31%) |
| descriptors only, raw | 509.6 | 409.7 (−20%) | 503.0 (−1%) |
| descriptors only, gzip | 115.7 | 77.9 (−33%) | 72.9 (−37%) |
| descriptors only, brotli | 88.3 | 61.2 (−31%) | 56.0 (−37%) |

- Rollup + terser and esbuild with `charset=utf8` land within 1–3% of
  these. Before minification, the `fileDesc(…)` source is larger: A is +18%
  and B is +39% raw. Compressed, it is −27% (A) and −31% (B).
- **Both minifiers fold Option A's `"…" + "…"` chains** into a single
  literal. No concatenation is left in any bundle.
- **Raw bytes are printed unescaped.** esbuild and terser write control
  characters (0x00–0x1f) as-is, and esbuild switches to template literals so
  that `\n` becomes a real line break. This is why minified A is smaller than
  base64 even before compression: the 4-character `\xNN` escapes in the
  source become 1 character.
  - esbuild `charset=ascii` (the default) re-escapes only bytes ≥ 0x80, as
    `\xNN`.
  - `charset=utf8` and terser emit them as raw U+0080–U+00FF characters,
    which take 2 bytes each in UTF-8.

Full tables, escape counts and samples: [`results/bundle-size.md`](results/bundle-size.md).

## Load time

Node v24.14.1 (V8 13.6), linux/x64. `Uint8Array.fromBase64` is not available
in this Node, and `@bufbuild/protobuf` 2.11.0's `base64Decode` uses its own
table-based decoder.

- **Cold:** a fresh process imports the minified esbuild bundle from above,
  30 runs, interleaved. "Hydrate" is the time from just before the first
  descriptor module until all of them have been evaluated.
- **Runtimes:** the shipped A/B runtimes re-encode their bytes to base64 so
  that they can call the stock `fileDesc`. The "direct" variants skip that
  round trip, as a native upstream implementation would.

| | import median | import p90 | hydrate median | hydrate p90 |
| --- | --- | --- | --- | --- |
| base64 | 104.6 ms | 111.8 ms | 97.7 ms | 104.9 ms |
| Option A (shipped runtime) | 115.2 ms | 120.0 ms | 106.8 ms | 110.6 ms |
| Option A (direct) | 103.0 ms | 108.1 ms | 94.5 ms | 99.7 ms |
| Option B (shipped runtime) | 124.7 ms | 130.2 ms | 109.3 ms | 114.8 ms |
| Option B (direct) | 114.3 ms | 121.9 ms | 97.6 ms | 106.1 ms |

Converting the literals of all 137 files into bytes, warm (tinybench, mean):

| base64 `base64Decode` | A chars → bytes | B `fromTree` |
| --- | --- | --- |
| 2.31 ms | 0.91 ms | 1.61 ms |

- Hydration time is dominated by `fromBinary` and building the registry,
  which are the same for every encoding.
- Implemented natively, A and B hydrate as fast as base64. The differences
  are within run-to-run noise (p90 − median ≈ 5–8 ms).
- B's gap between import and hydrate time is about 10 ms larger than
  base64's. The extra time goes into parsing the nested array literals.

## Caveats

- The replay models "two branches edited the same file", using real commits
  that were actually sequential. Pairs where C2 does not rebase onto C1^
  (30/115) are excluded, so the edits are probably closer together than
  typical concurrent work.
- Only `git merge-file` with default settings was used. The manifest relies
  on git conflicting on overlapping and adjacent changes. Other merge tools
  or `diff3`/`zdiff3` styles may report different hunks.
- "Clean but wrong" is an exact text comparison with the file regenerated
  from the merged `.proto`, so it would also flag harmless differences.
  Every case found was a real change of meaning.
- The matrix covers single edits per side on short lists. It does not cover
  a side that edits several lists at once, renames, or moves.
- Bundle sizes come from one API package. The descriptor share of a real
  application's bundle depends on how much else it ships.
- Load times are from one shared Linux VM. Browsers and other engines were
  not measured, and neither was a Node version with native
  `Uint8Array.fromBase64`. Whether newer `@bufbuild/protobuf` releases use it
  was not checked.

## Reproduce

```sh
pnpm install
pnpm --filter demo test           # Option B round trips, runtime and manifest checks
pnpm --filter demo conflict-demo  # results/conflict-demo.md
pnpm --filter demo replay         # results/replay/ (clones googleapis, ~10 min)
pnpm --filter demo shift-matrix   # results/shift-matrix.{md,tsv} (~12 min)
pnpm --filter demo bundle-size    # results/bundle-size.{md,json}
pnpm --filter demo load-bench     # results/load-bench.{md,json}
```

- The scripts make a blob-less partial clone of googleapis under `.work/`
  (git-ignored), or reuse the clone that `GOOGLEAPIS_DIR` points to. They read
  the pinned commit `GOOGLEAPIS_REV` in [`src/googleapis.ts`](src/googleapis.ts).
- `buf` comes from the `@bufbuild/buf` devDependency. `git` must be on the
  `PATH`.
- Wrong descriptors are validated with
  [`protodesc-check/`](protodesc-check/main.go) (protobuf-go v1.36.12). This
  needs Go (`go` on the `PATH`, or `GO=/path/to/go`); without it, the scripts
  skip the validation.
