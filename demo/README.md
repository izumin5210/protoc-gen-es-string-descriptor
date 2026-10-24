# Merge-friendly file descriptors: conflict replay and bundle-size benchmark

This directory holds the evidence for a feature request to
[protobuf-es](https://github.com/bufbuild/protobuf-es): embed file descriptors
in a form that survives concurrent edits. It is not part of the published
package.

**Proposal: nested array + names + number types.**

1. **Nested array.** The descriptor is embedded as nested arrays without
   length prefixes: `[tag, [children]]` for sub-messages, raw byte strings
   otherwise.
2. **Names instead of positions.**
   - `messageDesc(file, "Outer.Inner")`, and likewise `enumDesc`,
     `serviceDesc` and `extDesc`.
   - Synthetic oneofs of proto3 `optional` fields are left out and
     re-created on load.
   - Members of real oneofs, and public and weak imports, are listed by
     name.
3. **One import per line** in the imports array.
4. **Number types.** A type keyed by field or value number per message and
   enum, so that a duplicate number fails type checking with TS2300.

**Summary**

- **Replay of real history.** On 91 pairs of
  `google/cloud/aiplatform/v1` commits, base64 conflicted in 55 and the
  proposal in 1. The proposal merged none of them wrongly. Every encoding
  that keeps positions either merged some pairs into silently wrong code
  (string literal 2, nested array 5) or conflicted far more often (index
  manifest + number types: 8).
- **18 minimal scenarios.**
  - The proposal merges 12 of the 13 valid cases correctly, and the other
    one conflicts.
  - All 5 cases whose merged `.proto` is invalid end in an error, from
    TypeScript or from loading the descriptor.
  - The nested array alone is silently wrong in 8 cases.
- **Size.** Per generated file, the proposal is +6% minified and −29%
  gzipped compared with base64.
- **Lookup by name.** Resolving all 1,376 messages of 181 descriptors by
  name takes about 1 ms, including building the per-file maps (about
  110 KiB, compared with 4.0 MiB for the registry).
- **What names cost.** All oneof members and public imports of a file sit
  in one table. Two unrelated additions can therefore become adjacent there
  and conflict (1 of 85 replayed pairs on other files).
- A clean merge is still not proof of correctness, so CI should regenerate
  and compare.

Everything uses public data only:
[googleapis/googleapis](https://github.com/googleapis/googleapis) at
`4792db7b61d0`, plus the small hand-written protos in `scenarios/` and
`conflict-demo/`.

## Variants

| variant | what it embeds and emits |
| --- | --- |
| base64 | protoc-gen-es as is: one base64 string per file |
| string literal | this package: raw bytes as a string literal, split after every `0x0a`, as protoc-gen-go does |
| nested array | sub-messages as `[tag, [children]]` without length prefixes; positions unchanged |
| nested array + index manifest + number types | nested array without synthetic oneofs, plus a comment block that lists every position that generated code uses and the members of real oneofs, numbered imports when some are public or weak, and number types |
| nested array + names | the proposal without number types |
| **nested array + names + number types** | **the proposal** |

The detailed results also show three variants of an earlier iteration:

- **string literal + manifest** and **nested array + manifest** list every
  position in comments: imports, elements and all oneofs, synthetic ones
  included.
- **nested array + index manifest** lists only the positions that generated
  code uses.

## The encodings

All variants decode to the same bytes. protoc-gen-es strips `dependency`,
`source_code_info` and derivable `json_name`s and serializes the result. The
demo always starts from real protoc-gen-es output and rewrites it, so the
stripping is exactly upstream's. Every variant is checked to decode back to
those bytes, byte for byte, for every file that the scripts generate.

```ts
// base64: one line per file
fileDesc("ChhleGFtcGxlL3YxL2xpYnJhcnkucHJvdG8SCmV4YW1wbGUudjEiRwoEQm9vaxIM…");

// string literal: raw bytes, split after every 0x0a
fileDesc("" +
    "\n" +
    "\x18example/v1/library.proto\x12\n" +
    "example.v1\"G\n" +
    "\x04Book\x12\f\n" +
    "\x04name\x18\x01 \x01(\t\x12\r\n" +
    …);

// nested array: sub-messages become [tag, [children]]; their lengths are dropped
fileDesc([
 "\n\x18example/v1/library.proto",
 "\x12\nexample.v1",
 ["\"", [
  "\n\x04Book",
  ["\x12", [
   "\n\x04name",
   "\x18\x01 \x01(\t",
  ]],
  …
 ]],
 …
]);
```

The string literal still contains each message's length prefix (`"G` above
is `message_type`, 71 bytes). Any edit inside a message changes the length
of every ancestor, and the line that holds that length conflicts with any
other edit in the same ancestor. Worse, two edits that grow a message by the
same number of bytes change the length identically, and git merges them;
see [same-size edits](#string-literal-same-size-edits-to-one-message).

The nested array removes those lengths:

- The generator walks the wire format with `BinaryReader`. It uses
  `FileDescriptorProtoSchema` to decide which LEN fields are sub-messages,
  and emits `[tag, [children]]` for them.
- Every other string, bytes or packed field gets a line of its own.
  Consecutive scalars and unknown fields, such as option extensions, share
  one line. A field's name is thus on one line, and its number, label, type
  and `oneof_index` are on the next.
- There is one space of indentation per level and a trailing comma on every
  element, so an append never touches the previous line.
- The runtime needs no schema. It measures each subtree, writes
  `tag + varint(length) + body` into one buffer, and hands the bytes to the
  stock hydration.

Code: [`src/option-b/`](src/option-b/).

## The proposal: names + number types

Generated for a message `Event` with a oneof `kind { dep.A click = 2; }`,
an import of `dep/a.proto` and a public import of `dep/b.proto` (comments
added):

```ts
import { fileDesc, messageDesc } from "names-runtime";

export const file_example_v1_event: GenFile = /*@__PURE__*/
  fileDesc([
 "\n\x16example/v1/event.proto",
 "\x12\nexample.v1",
 ["\"", [
  "\n\x05Event",
  ["\x12", [
   "\n\x02id",
   "\x18\x01 \x01(\t",
  ]],
  ["\x12", [
   "\n\x05click",
   "\x18\x02 \x01(\v",        // number, label, type; no oneof_index
   "2\x06.dep.A",
  ]],
  ["B", [
   "\n\x04kind",
  ]],
 ]],
 "b\x06proto3",
 "\xd2\xf6\x03\x04\b\x00\x18\x00",
], [
  file_dep_a,                  // one import per line
  file_dep_b,
], [
  ["oneof", "Event.click", "kind"],
  ["public", file_dep_b],
]);
type _numbers_example_v1_Event = {
  1: "id";
  2: "click";
};

export const EventSchema: GenMessage<Event> = /*@__PURE__*/
  messageDesc(file_example_v1_event, "Event");
```

- **Names.** `messageDesc` & co take the name relative to the package. Map
  entries do not count as nested messages, as in protobuf-es's registry.
  The runtime looks names up in a map per file that it builds on first use,
  and still accepts numbers.
- **Synthetic oneofs** are dropped from the descriptor. On load they are
  re-created the way protoc names them: after the real oneofs, in field
  order, as `_<field>`, prefixed with `X` while that name is taken.
- **Real oneof members** are listed as `["oneof", "Msg.field", "oneof"]`
  instead of `oneof_index`.
- **Public and weak imports** are listed as references to the imported
  file objects, so the runtime finds them in the imports array by identity.
- **Number types** are emitted per message and per enum, except for map
  entries and enums with `allow_alias`. A duplicate number fails type
  checking with `TS2300: Duplicate identifier '3'`. They are erased in
  JavaScript. The tests check this with the real `tsc`.

Code: [`src/names/`](src/names/). The runtime
[`src/names/runtime.ts`](src/names/runtime.ts) restores the descriptor with
[`src/names/restore.ts`](src/names/restore.ts) and then hydrates it as usual.

**Why each part.** Generated code and the embedded descriptor refer to
elements by position:

| position | in | what goes wrong when both sides shift it | the proposal |
| --- | --- | --- | --- |
| `messageDesc(file, 2)` & co | generated code | an appended message keeps a stale index and points at another message | names |
| `oneof_index` | descriptor, per field | a field lands in the wrong oneof; for proto3 `optional`, in another field's synthetic oneof | synthetic oneofs dropped; real ones by name |
| `public_dependency`, `weak_dependency` | descriptor | another import becomes public | by name |
| length prefixes | string literal | same-size edits merge and cut a message short | none in a nested array |
| field and enum value numbers | descriptor | not positions, but both sides can add the same number | number types |

Other references in the descriptor (`type_name`, `extendee`, …) are already
names. A stale name, e.g. one side renames a message while the other uses
it, does not compile as `.proto` either, and the generated code fails
TypeScript (`TS2304: Cannot find name`).

**What it costs.**

- *Conflicts in the name table.* All oneof members and public imports of a
  file are in one table. If both sides add a oneof to different messages,
  their entries can land next to each other and conflict, whereas the
  nested array keeps `oneof_index` inside each field. This happened in 1 of
  85 replayed pairs of the other files (pubsub `8a4cc94afcb9` /
  `64ecfebceee5`).
- *A map field next to a nested message.* Map entries are nested types in
  the descriptor, so one side adding a map field and the other adding a
  nested message to the same message makes two adjacent additions. That
  conflicts in every variant.
- *Size.* Names are longer than indices, and the name table adds a line per
  oneof member: +6% minified per file compared with both base64 and the
  nested array.
- *Type checking.* The number types help only if generated code is
  type-checked. With `target=js+dts` they would live in `.d.ts` files, which
  `skipLibCheck` skips; the demo emits them for `target=ts` only.

## Scenario catalogue

[`scenarios/`](scenarios/) has 18 minimal pairs of concurrent edits whose
`.proto` merges cleanly. For each, the script generates every variant for
base, ours and theirs, merges the whole `_pb.ts` with `git merge-file`, and
judges the result as a user would see it:

- *correct*: identical to the file generated from the merged `.proto`, or
  it differs only in comments, number types or the text of `fileDesc(…)`
  and decodes to the same descriptor (this never happened here);
- *error*: the TypeScript compiler reports an error, or loading the
  descriptor with protobuf-es throws;
- *silently wrong*: neither, but the result differs.

| Scenario | base64 | string literal | nested array | nested array + index manifest + number types | nested array + names | **nested array + names + number types** |
| --- | --- | --- | --- | --- | --- | --- |
| ***Merged `.proto` is valid (ideal: correct)*** | | | | | | |
| One side inserts a message in the middle; the other appends one | ⚪ conflict | ❌ **silently wrong** | ❌ **silently wrong** | ⚪ conflict | ✅ correct | ✅ correct |
| Both sides add top-level enums at different positions | ⚪ conflict | ❌ **silently wrong** | ❌ **silently wrong** | ⚪ conflict | ✅ correct | ✅ correct |
| Both sides add `optional` fields to one message (adjacent) | ⚪ conflict | ⚪ conflict | ❌ **silently wrong** | ✅ correct | ✅ correct | ✅ correct |
| Both sides add `optional` fields to one message (a plain field in between) | ⚪ conflict | ⚪ conflict | ❌ **silently wrong** | ✅ correct | ✅ correct | ✅ correct |
| Both sides add `optional` fields to one message (far apart) | ⚪ conflict | ⚪ conflict | ⚪ conflict | ✅ correct | ✅ correct | ✅ correct |
| Both sides add same-size fields to one message (far apart) | ⚪ conflict | ❌ **silently wrong** | ✅ correct | ✅ correct | ✅ correct | ✅ correct |
| One side makes an import public; the other inserts an import before it | ⚪ conflict | ⚪ conflict | ❌ **silently wrong** | ⚪ conflict | ✅ correct | ✅ correct |
| One side inserts a oneof before an existing one; the other adds a member to the existing one | ⚪ conflict | ⚪ conflict | ❌ **silently wrong** | ⚪ conflict | ✅ correct | ✅ correct |
| Both sides add fields to one message (far apart) | ⚪ conflict | ⚪ conflict | ✅ correct | ✅ correct | ✅ correct | ✅ correct |
| Both sides add RPCs to one service (far apart) | ⚪ conflict | ⚪ conflict | ✅ correct | ✅ correct | ✅ correct | ✅ correct |
| Both sides add nested messages to different parents | ⚪ conflict | ⚪ conflict | ✅ correct | ⚪ conflict | ✅ correct | ✅ correct |
| One side adds a map field; the other adds a nested message to the same message | ⚪ conflict | ⚪ conflict | ⚪ conflict | ⚪ conflict | ⚪ conflict | ⚪ conflict |
| Both sides add different imports | ⚪ conflict | ⚪ conflict | ⚪ conflict | ✅ correct | ✅ correct | ✅ correct |
| ***Merged `.proto` is invalid (ideal: conflict or error)*** | | | | | | |
| Both sides add a field with the same number | ⚪ conflict | ⚪ conflict | ❌ **silently wrong** | ⚠️ error | ❌ **silently wrong** | ⚠️ error |
| Both sides add an enum value with the same number | ⚪ conflict | ⚪ conflict | ❌ **silently wrong** | ⚠️ error | ❌ **silently wrong** | ⚠️ error |
| Both sides add a field with the same name | ⚪ conflict | ⚪ conflict | ⚠️ error | ⚠️ error | ⚠️ error | ⚠️ error |
| One side renames a message; the other references the old name | ⚪ conflict | ⚠️ error | ⚠️ error | ⚠️ error | ⚠️ error | ⚠️ error |
| Both sides add a message with the same name | ⚪ conflict | ⚠️ error | ⚠️ error | ⚪ conflict | ⚠️ error | ⚠️ error |

- **Duplicate numbers** are the reason for the number types. Without them,
  protobuf-es loads a message with two fields numbered 3, and nothing
  complains.
- **Duplicate names** were already errors: generated code declares a
  property, an enum member or an export per name, and TypeScript rejects
  duplicates.
- **Every variant that keeps positions** merges at least one valid case
  silently wrong or conflicts on it.

All variants, with diffs and error messages:
[`results/scenarios.md`](results/scenarios.md).

## Readable demo: what conflicts and why

[`conflict-demo/`](conflict-demo/) has nine more pairs of edits, with every
hunk and diff in [`results/conflict-demo.md`](results/conflict-demo.md).
Five of them are variants of catalogue scenarios with a different layout,
and every variant merges them the same way: the index shift (01), `optional`
fields adjacent (03) and separated (04), same-size fields (06) and the public
import (12).

| scenario | base64 | string literal | string literal + manifest | nested array | nested array + index manifest | nested array + manifest | nested array + index manifest + number types | nested array + names | nested array + names + number types |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| same service, different RPCs added | conflict | conflict | conflict | clean | clean | clean | clean | clean | clean |
| same message, different fields added | conflict | conflict | conflict | clean | clean | clean | clean | clean | clean |
| message inserted right before a message the other side changed | conflict | conflict | conflict | clean | clean | clean | clean | clean | clean |
| control: different messages changed | conflict | clean | clean | clean | clean | clean | clean | clean | clean |
| `Profile` inserted before `Team` / `Invoice` appended | conflict | **wrong** (code) | conflict | **wrong** (code) | conflict | conflict | conflict | clean | clean |
| optional `bio` inserted / optional `phone` appended right after | conflict | conflict | conflict | **wrong** (descriptor) | **wrong** (descriptor) | conflict | clean | clean | clean |
| the same, with a plain field between `email` and `phone` | conflict | conflict | conflict | **wrong** (descriptor) | **wrong** (descriptor) | conflict | clean | clean | clean |
| `bio` inserted / `age` appended, same byte size | conflict | **wrong** (descriptor) | **wrong** (descriptor) | clean | clean | clean | clean | clean | clean |
| import made public / import inserted before it | conflict | conflict | conflict | **wrong** (descriptor) | **wrong** (descriptor) | conflict | conflict | clean | clean |

Every "clean" result above is byte-identical to the regenerated file.

**Index shift in generated code.** Both descriptors merge correctly, but
`InvoiceSchema` keeps theirs' `messageDesc(file, 2)` although ours moved
`Team` to 2:

```diff
# merged nested array (- expected, + merged)
 export const InvoiceSchema: GenMessage<Invoice> = /*@__PURE__*/
-  messageDesc(file_example_v1_library, 3);
+  messageDesc(file_example_v1_library, 2);
```

With names, both sides write `messageDesc(file, "Invoice")` and
`messageDesc(file, "Team")`, which do not change when something is
inserted.

**`oneof_index`.** Ours inserts optional `bio`, theirs appends optional
`phone`. The nested array keeps `phone`'s `oneof_index` on a line of its
own, so the merge keeps theirs' 2, which is now `_email`:

```diff
# merged nested array (- expected, + merged)
-   "\x18\x05 \x01(\tH\x03\x88\x01\x01",
+   "\x18\x05 \x01(\tH\x02\x88\x01\x01",
```

protobuf-es ignores `oneof_index` for proto3 `optional` fields (`findOneof`
in `@bufbuild/protobuf` 2.11.0's `registry.js`), so the runtime behaves the
same. But the descriptor itself changes meaning, and protobuf-go rejects
it: `proto: message field "example.v1.User.email" under proto3 optional
semantics must be within a single element oneof`. Anything that reads
`file.proto`, e.g. gRPC server reflection, passes the broken descriptor on.
The proposal has no synthetic oneofs to shift.

**`public_dependency`.** Ours makes `dep/b.proto` public
(`public_dependency` = 1). Theirs inserts `dep/c.proto` first, so `b` moves
to 2. Only theirs changes the imports array, so the nested array merges, and
`public_dependency` now points at `dep/a.proto`. Both protobuf-es and
protobuf-go accept it. The proposal records `["public", file_dep_b]`.

### String literal: same-size edits to one message

Ours inserts `string bio = 4;` after `id`, theirs appends `string age = 5;`.
Both grow `User` by 13 bytes, so both rewrite its length prefix to the same
value, and git keeps it once:

```diff
# merged string literal (- expected, + merged)
-    "example.v1\"I\n" +
+    "example.v1\"<\n" +
```

`User` now ends before `age`, whose bytes are parsed as the file's
`package`. protobuf-es loads the file without an error:

```diff
-message "example.v1.User" { id = 1; bio = 4; name = 2; email = 3; age = 5 }
+message "\n\u0003age\u0018\u0005 \u0001(\t.User" { id = 1; bio = 4; name = 2; email = 3 }
```

`toJsonString(create(UserSchema, { id: "1", age: "20" }))` gives
`{"id":"1"}`: `age` is silently dropped. protobuf-go rejects the descriptor
(`invalid package`). No index moved, so no manifest can see it. A nested
array has no length prefixes and merges this case correctly.

## Replay on googleapis history

**Method.** For the last 40 consecutive commit pairs (C1, C2) touching each
file:

1. base = C1^, ours = C1, theirs = C2's own diff applied to C1^
   (`git merge-file -p <C1^> <C2^> <C2>`). Skip the pair if that conflicts.
2. Merge the `.proto` (`git merge-file ours base theirs`). If it conflicted,
   it would count as a semantic conflict; this never happened, because C2
   already rebased cleanly onto C1^.
3. `buf build --exclude-source-info` each side. All four sides use C2's
   imports, so only the replayed file differs between them. Otherwise
   dependency changes, such as `[packed = false]` on
   `google.api.field_behavior`, leak into the bytes.
4. Run protoc-gen-es, derive every variant, merge the whole generated
   `_pb.ts` with `git merge-file`, and judge it as in the scenario
   catalogue.

**`google/cloud/aiplatform/v1`.** `prediction_service.proto`,
`content.proto` and `tool.proto`: 112 pairs, 16 of which do not rebase and 5
of which do not build at C2's imports; 91 are replayed. In 36 of them, one
side does not change the generated file at all.

| variant | correct | conflict | silently wrong | error |
| --- | --- | --- | --- | --- |
| base64 | 36 | 55 | 0 | 0 |
| string literal | 64 | 25 | **2** | 0 |
| nested array | 84 | 2 | **5** | 0 |
| nested array + index manifest + number types | 83 | 8 | 0 | 0 |
| nested array + names | 90 | 1 | 0 | 0 |
| **nested array + names + number types** | 90 | 1 | 0 | 0 |

- **The proposal's one conflict** (prediction_service `0830bd94d` /
  `7d37a81f6`) is in the generated code outside the descriptor, so every
  variant conflicts.
- **The index manifest's 7 extra conflicts** come from both sides adding
  messages or enums. Each addition renumbers the manifest lines after it,
  and those lines are next to the other side's addition. 5 of the 7 are
  pairs that the nested array merges wrongly.
- **The nested array's 5 wrong merges** are index shifts in generated code.

**Three other files.** `google/container/v1/cluster_service.proto`,
`google/pubsub/v1/pubsub.proto` and
`google/cloud/deploy/v1/cloud_deploy.proto`: 115 pairs, 85 replayed.

| variant | correct | conflict | silently wrong | error |
| --- | --- | --- | --- | --- |
| base64 | 39 | 46 | 0 | 0 |
| string literal | 68 | 15 | **2** | 0 |
| nested array | 72 | 9 | **4** | 0 |
| nested array + index manifest + number types | 72 | 13 | 0 | 0 |
| nested array + names | 78 | 7 | 0 | 0 |
| **nested array + names + number types** | 78 | 7 | 0 | 0 |

- **The nested array's 4 wrong merges** are 3 index shifts in generated code
  and 1 `oneof_index` (cluster_service `f0a78c77d2` / `449133156d`: both
  sides added a proto3 `optional` field to `ClusterUpdate`).
- **The proposal** is correct in 7 pairs where the nested array conflicts or
  is wrong. It conflicts in 1 pair where the nested array is correct: the
  name table case above.

Per-file tables, the earlier manifest variants and `fileDesc(…)` merged
alone: [`results/replay-aiplatform/summary.md`](results/replay-aiplatform/summary.md),
[`results/replay/summary.md`](results/replay/summary.md). Per-pair results
with commit SHAs are in `pairs.tsv` next to them.

## Synthetic matrix

Real history covers only some patterns, so
[`scripts/shift-matrix.ts`](scripts/shift-matrix.ts) applies every pair of
single edits to a small schema. Its lists have 3 elements each:

- what generated code indexes into: top-level and nested messages, enums
  and extensions, and services;
- imports (none public at first);
- the values of an enum and the methods of a service.

It also has 9 fields of one message: plain, proto3 `optional` and real
oneof fields, interleaved.

Each side inserts at the front, in the middle or at the end, or deletes the
first or the last element. Fields are added and deleted per kind, and an
import can also be made public. Every ordered pair runs twice: with both
sides adding elements of the same byte size, and of different sizes. Of
8,712 pairs, 440 conflict as `.proto` and are excluded. The whole `_pb.ts`
is judged as in the scenario catalogue.

| variant | correct | conflict | error | silently wrong: generated code | silently wrong: descriptor |
| --- | --- | --- | --- | --- | --- |
| base64 | 0 | 8,272 | 0 | 0 | 0 |
| string literal | 5,848 | 2,333 | 24 | 55 | 12 |
| nested array | 7,660 | 416 | 0 | 148 | 48 |
| nested array + index manifest + number types | 7,736 | 536 | 0 | 0 | 0 |
| nested array + names | 8,208 | 64 | 0 | 0 | 0 |
| **nested array + names + number types** | 8,184 | 88 | 0 | **0** | **0** |

- **The proposal merges no pair wrongly**, and conflicts in 88.
- **Its number types cost 24 of those conflicts.** The type blocks of
  neighbouring lists are adjacent, e.g. a message's nested enums and its
  nested messages, so editing the end of one and the start of the other
  conflicts.
- **The string literal's same-size edits** are the 12 wrong descriptors and
  the 24 errors: the orphaned bytes either still parse, or make loading
  throw.
- **The nested array's 48 wrong descriptors** are `oneof_index` and
  `public_dependency` shifts; its 148 wrong merges in generated code are
  index shifts.

The earlier manifest variants, per-size tables and every pair where a
variant is wrong or a manifest or the number types change the outcome:
[`results/shift-matrix.md`](results/shift-matrix.md),
[`results/shift-matrix.tsv`](results/shift-matrix.tsv).

## Size

**Per generated file.** All 173 generated files of
`google/cloud/aiplatform/v1` with its subpackages and imports, well-known
types excluded, `target=ts`. Sizes in KiB, summed over the files; gzip
level 9 per file.

| variant | comments and whitespace removed | gzip | `esbuild --minify` | gzip |
| --- | --- | --- | --- | --- |
| base64 | 1,242.8 | 346.7 | 790.2 | 276.3 |
| string literal | 1,306.0 (+5%) | 265.7 (−23%) | 689.7 (−13%) | 195.1 (−29%) |
| nested array | 1,382.9 (+11%) | 257.1 (−26%) | 796.7 (+1%) | 194.9 (−29%) |
| nested array + index manifest + number types | 1,374.0 (+11%) | 256.1 (−26%) | 789.9 (±0%) | 193.6 (−30%) |
| nested array + names | 1,424.5 (+15%) | 261.3 (−25%) | 841.5 (+6%) | 196.5 (−29%) |
| **nested array + names + number types** | 1,424.5 (+15%) | 261.3 (−25%) | 841.5 (+6%) | 196.5 (−29%) |

- The first column removes comments, number types, indentation and line
  breaks, and keeps the other TypeScript types. Comments are only removed
  outside string literals: descriptor strings contain `/*`, e.g. in HTTP
  paths such as `projects/*/locations`.
- `esbuild --minify` also removes all types and escapes as a bundle would
  (`charset=ascii`).
- base64 hides repeated names from the compressor, which is why every other
  variant compresses better.

**In a real bundle.** An entry imports every `file_*` export of
`google/cloud/aiplatform/v1` and its imports (137 files without
subpackages), bundled with esbuild `--bundle --minify` (0.28.2) and with
Rollup 4.65 + terser. "Descriptors only" is the full bundle minus a bundle
whose descriptors are emptied. Sizes in KiB, gzip level 9, brotli quality
11.

| esbuild, charset=ascii | base64 | string literal | nested array |
| --- | --- | --- | --- |
| bundle, raw | 578.0 | 478.5 (−17%) | 584.4 (+1%) |
| bundle, gzip | 134.2 | 96.6 (−28%) | 92.2 (−31%) |
| bundle, brotli | 104.5 | 77.4 (−26%) | 72.8 (−30%) |
| descriptors only, raw | 509.6 | 409.7 (−20%) | 515.1 (+1%) |
| descriptors only, gzip | 115.7 | 77.9 (−33%) | 73.4 (−37%) |
| descriptors only, brotli | 88.3 | 61.2 (−31%) | 56.3 (−36%) |

- Rollup + terser and esbuild with `charset=utf8` land within 1–3% of
  these.
- **Both minifiers fold the string literal's `"…" + "…"` chains** into a
  single literal.
- **Raw bytes are printed unescaped.** esbuild and terser write control
  characters (0x00–0x1f) as-is, and esbuild switches to template literals so
  that `\n` becomes a real line break. esbuild `charset=ascii` (the default)
  re-escapes only bytes ≥ 0x80, as `\xNN`; `charset=utf8` and terser emit
  them as raw U+0080–U+00FF characters, which take 2 bytes each in UTF-8.

Full tables: [`results/file-sizes.md`](results/file-sizes.md),
[`results/bundle-size.md`](results/bundle-size.md).

## Lookup by name

[`scripts/name-lookup.ts`](scripts/name-lookup.ts) resolves every message
of the 181 descriptors above (well-known types included) once, with the
demo runtime's map per file:

| | time (median of 11) | memory |
| --- | --- | --- |
| by index, `messageDesc(file, 2, 0)` | 0.11 ms | — |
| by name, building the maps first | 0.92 ms | 114 KiB for 1,565 elements |
| for comparison: the registry | — | 4.0 MiB, plus 3.7 MiB for the parsed descriptors it keeps |

The times vary by about ±0.2 ms between runs.

## Load time

Node v24.14.1 (V8 13.6), linux/x64, with the 137-file esbuild bundle from
above. `Uint8Array.fromBase64` is not available in this Node, and
`@bufbuild/protobuf` 2.11.0's `base64Decode` uses its own table-based
decoder.

- **Cold:** a fresh process imports the minified bundle, 30 runs,
  interleaved. "Hydrate" is the time from just before the first descriptor
  module until all of them have been evaluated.
- **Runtimes:** the shipped runtimes re-encode their bytes to base64 so that
  they can call the stock `fileDesc`. The "direct" variants skip that round
  trip, as a native upstream implementation would.

| | import median | import p90 | hydrate median | hydrate p90 |
| --- | --- | --- | --- | --- |
| base64 | 104.1 ms | 113.4 ms | 97.2 ms | 106.4 ms |
| string literal (shipped runtime) | 115.7 ms | 125.5 ms | 107.1 ms | 117.2 ms |
| string literal (direct) | 104.7 ms | 111.3 ms | 96.0 ms | 102.5 ms |
| nested array (shipped runtime) | 125.8 ms | 132.9 ms | 109.3 ms | 116.3 ms |
| nested array (direct) | 115.9 ms | 121.4 ms | 99.5 ms | 106.0 ms |

- Hydration time is dominated by `fromBinary` and building the registry,
  which are the same for every encoding. Implemented natively, the nested
  array hydrates as fast as base64; the differences are within run-to-run
  noise.
- The nested array's import time is about 16 ms above its hydrate time,
  compared with 7 ms for base64. The extra time goes into parsing the array
  literals.
- The names variants were not measured. Their runtime re-creates the
  synthetic oneofs and name entries on the parsed descriptor, which an
  upstream implementation would do before building the registry.

Warm conversion and full tables: [`results/load-bench.md`](results/load-bench.md).

## Caveats

- The replay models "two branches edited the same file", using real commits
  that were actually sequential. Pairs where C2 does not rebase onto C1^ are
  excluded, so the edits are probably closer together than typical
  concurrent work.
- Only `git merge-file` with default settings was used. Other merge tools,
  or `diff3`/`zdiff3` styles, may report different hunks.
- "Silently wrong" is an exact comparison with the file regenerated from the
  merged `.proto`, after decoding the descriptor, so it would also flag
  harmless differences. Every case found was a real change of meaning.
- The matrix covers single edits per side on short lists. It does not cover
  a side that edits several lists at once, renames, or moves.
- The runtime for names restores the descriptor with `fromBinary` /
  `toBinary` before hydrating it. Its load time has not been measured.
- Go was not available when the results were last regenerated, so wrong
  descriptors were not loaded with protobuf-go this time. The protobuf-go
  messages quoted above are from earlier runs of the same cases.
- Sizes come from one API package. The descriptor share of a real
  application's bundle depends on how much else it ships.

## Reproduce

```sh
pnpm install
pnpm --filter demo test                   # round trips, runtimes, number types with tsc
pnpm --filter demo scenarios              # results/scenarios.{md,json}
pnpm --filter demo conflict-demo          # results/conflict-demo.md
pnpm --filter demo replay aiplatform      # results/replay-aiplatform/ (clones googleapis)
pnpm --filter demo replay                 # results/replay/ (~10 min)
pnpm --filter demo shift-matrix           # results/shift-matrix.{md,tsv}
pnpm --filter demo file-sizes             # results/file-sizes.md
pnpm --filter demo name-lookup            # results/name-lookup.md
pnpm --filter demo bundle-size            # results/bundle-size.{md,json}
pnpm --filter demo load-bench             # results/load-bench.{md,json}
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
