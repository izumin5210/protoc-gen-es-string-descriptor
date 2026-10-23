# Merge-friendly file descriptors: conflict replay and bundle-size benchmark

This directory holds the evidence for a feature request to
[protobuf-es](https://github.com/bufbuild/protobuf-es): embed file descriptors
in a form that survives concurrent edits. It is not part of the published
package.

**Summary**

- `protoc-gen-es` embeds each `FileDescriptorProto` as one base64 line, so any
  two branches that change the same `.proto` conflict in the generated code.
  Replaying 46 pairs of real googleapis commits where both sides changed the
  descriptor, base64 conflicted in **all 46**.
- **Option A** (this package: raw byte strings split after `0x0a`) merges
  **33/46** cleanly. **Option B** (nested arrays without length prefixes)
  merges **44/46** cleanly.
- Both are smaller than base64 after minification and compression: the
  descriptor portion of a real esbuild bundle is **−33% (A) / −37% (B) gzip**.
  The cost is a few milliseconds of hydration time.
- A clean textual merge is not always a correct one. Generated code also
  contains **positional references** that two branches can shift in the same
  way: `messageDesc(file, 12)` and, inside the descriptor, the `oneof_index`
  of proto3 `optional` fields. Such merges succeed silently but produce wrong
  code (4 of 46 with B, 2 with A). So a merge-friendly encoding cuts down
  manual conflict resolution, but CI still has to regenerate and compare.

| encoding | descriptor: clean and correct | descriptor: clean but wrong | whole `_pb.ts` conflicts | whole `_pb.ts` clean but wrong | bundle gzip (descriptors) | cold hydrate (median) |
| --- | --- | --- | --- | --- | --- | --- |
| base64 (protoc-gen-es) | 0 / 46 | 0 | 46 | 0 | 115.7 KiB | 97.7 ms |
| Option A | 33 / 46 | 0 | 15 | 2 | 77.9 KiB | 106.8 ms (94.5 ms direct) |
| Option B | 44 / 46 | 1 | 7 | 4 | 72.9 KiB | 109.3 ms (97.6 ms direct) |

The sections below explain each number. Everything uses public data only:
[googleapis/googleapis](https://github.com/googleapis/googleapis) at
`4792db7b61d0` plus the small hand-written protos in `conflict-demo/`.

## The three encodings

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

## Readable demo: what conflicts and why

`conflict-demo/` has one base proto and four pairs of edits. Every pair
merges cleanly as `.proto`. The script generates all three encodings for
base, ours and theirs, then runs `git merge-file`.

| scenario | base64 | Option A | Option B |
| --- | --- | --- | --- |
| same service, different RPCs added | conflict | conflict | clean |
| same message, different fields added | conflict | conflict | clean |
| message inserted right before a message the other side changed | conflict | conflict | clean |
| control: different messages changed | conflict | clean | clean |

Every clean merge decodes to the descriptor built from the merged `.proto`.
The Option A conflicts are all length prefixes:

```js
// same service, different RPCs: the service's length (0x91 0x02 vs 0x8e 0x02)
<<<<<<< ours
    "\x04name\x18\x01 \x01(\t2\x91\x02\n" +
=======
    "\x04name\x18\x01 \x01(\t2\x8e\x02\n" +
>>>>>>> theirs

// same message, different fields: Book's length ("U" vs "Y")
<<<<<<< ours
    "example.v1\"U\n" +
=======
    "example.v1\"Y\n" +
>>>>>>> theirs

// inserted message: the new message lands on the line holding Shelf's length
<<<<<<< ours
    "page_count\x18\x04 \x01(\x05\"\x16\n" +
    "\x06Author\x12\f\n" +
    "\x04name\x18\x01 \x01(\t\"$\n" +
=======
    "page_count\x18\x04 \x01(\x05\"6\n" +
>>>>>>> theirs
```

With Option B, each side's change is confined to its own lines:

```diff
# ours
   ["\x12", ["\n\x04name\x18\x01 \x01(\t"]],
+  ["\x12", ["\n\x04isbn\x18\x05 \x01(\t"]],
   ["\x12", ["\n\x05title\x18\x02 \x01(\t"]],
# theirs
   ["\x12", ["\n\npage_count\x18\x04 \x01(\x05"]],
+  ["\x12", ["\n\blanguage\x18\x06 \x01(\t"]],
  ]],
```

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
4. Run protoc-gen-es, derive A and B, and merge two things with
   `git merge-file`: the `fileDesc(…)` expression alone, and the whole
   generated `_pb.ts`.
5. For every clean merge, decode the result and compare it with the
   descriptor built from the merged `.proto`. For the whole file, compare it
   with the file generated from the merged `.proto`.

**Results.** Of 115 pairs, 30 did not rebase and 85 were replayed. In 39 of
those, one side did not change the descriptor (e.g. a comment-only commit),
and every encoding merges trivially. The other 46 pairs:

| file | encoding | clean | conflict | clean but wrong | whole `_pb.ts`: conflict | whole `_pb.ts`: clean but wrong |
| --- | --- | --- | --- | --- | --- | --- |
| cluster_service.proto | base64 | 0 | 17 | 0 | 17 | 0 |
| | Option A | 15 | 2 | 0 | 3 | 0 |
| | Option B | 16 | 0 | 1 | 2 | 1 |
| pubsub.proto | base64 | 0 | 15 | 0 | 15 | 0 |
| | Option A | 10 | 5 | 0 | 6 | 2 |
| | Option B | 14 | 1 | 0 | 2 | 3 |
| cloud_deploy.proto | base64 | 0 | 14 | 0 | 14 | 0 |
| | Option A | 8 | 6 | 0 | 6 | 0 |
| | Option B | 14 | 0 | 0 | 3 | 0 |
| **total** | base64 | 0 | 46 | 0 | 46 | 0 |
| | Option A | 33 | 13 | 0 | 15 | 2 |
| | Option B | 44 | 1 | 1 | 7 | 4 |

Per-pair records with commit SHAs: [`results/replay/`](results/replay/).

**The cases Option B does not handle:**

- *Conflict (1).* Both sides added a new top-level message at the same place
  in the descriptor (pubsub `69e9dff10d` / `d992b0619e`). In the `.proto` the
  two insertions were separated by comments. Comments are not in the
  descriptor, so there the insertions are adjacent.
- *Clean but wrong descriptor (1).* Both sides added a proto3 `optional` field
  to the same message (cluster_service `f0a78c77d2` / `449133156d`). Each
  field gets a synthetic oneof, and `oneof_index` is a position in the
  message's `oneof_decl` list. Both sides wrote `oneof_index = 3`, the merge
  kept both, and the correct value for the second field is 4. A has the same
  exposure; it only escaped here because the pair conflicted on lengths
  first.
- *Whole-file conflicts and clean-but-wrong files.* Outside the descriptor,
  generated code refers to messages and enums by position:
  `messageDesc(file_x, 73)`, `enumDesc(file_x, 77, 0)`.
  - When both sides insert a message, these lines conflict.
  - When both insert before the same index, both rewrite `N` to `N + 1`.
    Git accepts identical changes, and the merged file silently points at the
    wrong message (correct: `N + 2`).
  - This is independent of the descriptor encoding, so a proposal has to
    address it too, e.g. by referring to elements by name.

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
- Only `git merge-file` with default settings was used. Other merge drivers
  or `diff3`/`zdiff3` styles may report different hunks.
- Whole-file "clean but wrong" is an exact text comparison with the file
  regenerated from the merged `.proto`. Every case found was a positional
  index, but the check would also flag harmless differences.
- Bundle sizes come from one API package. The descriptor share of a real
  application's bundle depends on how much else it ships.
- Load times are from one shared Linux VM. Browsers and other engines were
  not measured, and neither was a Node version with native
  `Uint8Array.fromBase64`. Whether newer `@bufbuild/protobuf` releases use it
  was not checked.

## Reproduce

```sh
pnpm install
pnpm --filter demo test           # Option B round trips and runtime checks
pnpm --filter demo conflict-demo  # results/conflict-demo.md
pnpm --filter demo replay         # results/replay/ (clones googleapis, ~7 min)
pnpm --filter demo bundle-size    # results/bundle-size.{md,json}
pnpm --filter demo load-bench     # results/load-bench.{md,json}
```

- The scripts make a blob-less partial clone of googleapis under `.work/`
  (git-ignored), or reuse the clone that `GOOGLEAPIS_DIR` points to. They read
  the pinned commit `GOOGLEAPIS_REV` in [`src/googleapis.ts`](src/googleapis.ts).
- `buf` comes from the `@bufbuild/buf` devDependency. `git` must be on the
  `PATH`.
