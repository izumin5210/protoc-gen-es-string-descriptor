import { clone, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  messageDesc as messageDescByPath,
  fileDesc as originalFileDesc,
  pathInFileDesc,
} from "@bufbuild/protobuf/codegenv2";
import { nestedTypes } from "@bufbuild/protobuf/reflect";
import { base64Encode } from "@bufbuild/protobuf/wire";
import { FileDescriptorProtoSchema } from "@bufbuild/protobuf/wkt";
import { bench, describe } from "vitest";
import { embedNames, restoreNames } from "../names.js";
import { fileDesc, messageDesc } from "../runtime.js";
import { evaluateTree, fromTree, toTree } from "../tree.js";
import { bufBuildFiles } from "./helpers.js";

// A large proto3 file with the features that the name markers and synthetic
// oneofs cover: 300 messages of 16 fields, 3 of them optional and 2 in a
// oneof.
const proto = [
  'syntax = "proto3";',
  "package bench.v1;",
  ...Array.from({ length: 300 }, (_, m) =>
    [
      `message Message${m} {`,
      ...Array.from(
        { length: 11 },
        (_, f) => `  string field_${f} = ${f + 1};`,
      ),
      ...Array.from(
        { length: 3 },
        (_, f) => `  optional int64 opt_${f} = ${f + 12};`,
      ),
      "  oneof kind {",
      "    string a = 15;",
      "    int32 b = 16;",
      "  }",
      "}",
    ].join("\n"),
  ),
].join("\n");
const [source] = bufBuildFiles({ "bench.proto": proto });
// What protoc-gen-es embeds.
const embedded = clone(FileDescriptorProtoSchema, source);
embedded.dependency = [];
for (const m of embedded.messageType) {
  for (const f of m.field) {
    f.jsonName = "";
  }
}
const bytes = toBinary(FileDescriptorProtoSchema, embedded);
const b64 = base64Encode(bytes, "std_raw");
const raw = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
const stripped = clone(FileDescriptorProtoSchema, embedded);
embedNames(stripped, []);
const tree = evaluateTree(
  toTree(toBinary(FileDescriptorProtoSchema, stripped)),
);

describe(`fileDesc (${bytes.length} bytes, 300 messages)`, () => {
  bench("codegenv2 fileDesc(base64), as protoc-gen-es generates", () => {
    originalFileDesc(b64);
  });
  bench("fileDesc(raw byte string), as earlier versions generate", () => {
    fileDesc(raw);
  });
  bench("fileDesc(tree, imports)", () => {
    fileDesc(tree, []);
  });
  bench("fileDesc(tree, imports) via toBinary + base64 into codegenv2", () => {
    const file = fromBinary(FileDescriptorProtoSchema, fromTree(tree));
    restoreNames(file);
    originalFileDesc(
      base64Encode(toBinary(FileDescriptorProtoSchema, file), "std_raw"),
    );
  });
});

describe("steps of fileDesc(tree, imports)", () => {
  bench("fromTree", () => {
    fromTree(tree);
  });
  bench("fromTree + fromBinary + restoreNames", () => {
    restoreNames(fromBinary(FileDescriptorProtoSchema, fromTree(tree)));
  });
});

// The map of names is built on the first lookup per file, so every
// iteration needs a file that has not been looked up yet.
const fresh = Array.from({ length: 50 }, () => originalFileDesc(b64));
let next = 0;
const once = {
  iterations: fresh.length,
  time: 0,
  warmupIterations: 0,
  warmupTime: 0,
};

describe("look up every message of a file once", () => {
  bench(
    "by path",
    () => {
      const file = fresh[next++ % fresh.length];
      for (const desc of nestedTypes(file)) {
        const [first, ...rest] = pathInFileDesc(desc);
        messageDescByPath(file, first, ...rest);
      }
    },
    once,
  );
  bench(
    "by name, building the map",
    () => {
      const file = fresh[next++ % fresh.length];
      for (const desc of nestedTypes(file)) {
        messageDesc(file, desc.name);
      }
    },
    once,
  );
});
