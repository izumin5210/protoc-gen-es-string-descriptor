import { create, createFileRegistry, fromBinary } from "@bufbuild/protobuf";
import {
  CodeGeneratorRequestSchema,
  type FileDescriptorProto,
  FileDescriptorSetSchema,
} from "@bufbuild/protobuf/wkt";
import { protocGenEs } from "@bufbuild/protoc-gen-es/dist/cjs/src/protoc-gen-es-plugin.js";
import { transformFileContent } from "../../src/transform.js";
import {
  indexManifest,
  insertIndexManifest,
  oneofMemberManifest,
  withManifestHeader,
} from "./manifest.js";
import { transformFileContentInline } from "./names/inline-transform.js";
import { transformFileContentToNames } from "./names/table-transform.js";
import { transformFileContentToTree } from "./option-b/transform.js";

export const ENCODINGS = ["base64", "a", "b"] as const;
export type Encoding = (typeof ENCODINGS)[number];

/**
 * Encodings plus manifest and names variants, compared when merging.
 *
 * - "index manifest" lists only what generated code looks up by position
 *   (the wrapper feature); "manifest" also lists imports and oneofs, which
 *   the descriptor refers to by position.
 * - "index manifest + number types" leaves synthetic oneofs out, lists the
 *   members of real oneofs, numbers the imports when some are public or
 *   weak, and adds a type keyed by number per message and enum.
 * - "names" refers to elements by name, marks real oneof members and public
 *   / weak imports by name inline in the descriptor, and puts one import
 *   per line; "+ number types" is the proposal.
 * - "name table + number types" is an earlier form of the proposal: oneof
 *   members and public / weak imports in a third `fileDesc` argument.
 */
export const VARIANTS = [
  "base64",
  "a",
  "a-manifest",
  "b",
  "b-index-manifest",
  "b-manifest",
  "b-index-manifest-numbers",
  "b-name-table-numbers",
  "b-names",
  "b-names-numbers",
] as const;
export type Variant = (typeof VARIANTS)[number];

export const VARIANT_LABELS: Record<Variant, string> = {
  base64: "base64",
  a: "String literal",
  "a-manifest": "String literal + manifest",
  b: "Nested array",
  "b-index-manifest": "Nested array + index manifest",
  "b-manifest": "Nested array + manifest",
  "b-index-manifest-numbers": "Nested array + index manifest + number types",
  "b-name-table-numbers": "Nested array + name table + number types",
  "b-names": "Nested array + names",
  "b-names-numbers": "Nested array + names + number types",
};

/** How the first argument of `fileDesc` is decoded. */
export type DescriptorFormat = Encoding | "b-stripped" | "names" | "name-table";

export function formatOf(variant: Variant): DescriptorFormat {
  if (variant.startsWith("b-names")) {
    return "names";
  }
  if (variant === "b-name-table-numbers") {
    return "name-table";
  }
  if (variant === "b-index-manifest-numbers") {
    return "b-stripped";
  }
  return variant.split("-")[0] as Encoding;
}

export const OPTION_B_RUNTIME = "option-b-runtime";
export const NAMES_RUNTIME = "names-runtime";
export const NAME_TABLE_RUNTIME = "name-table-runtime";

export interface GeneratedFile {
  name: string;
  content: Record<Variant, string>;
}

/**
 * Run the real protoc-gen-es on a `buf build` image and derive every variant
 * from its output, so that all embed exactly the descriptor that
 * protoc-gen-es strips and serializes.
 */
export function generate(
  image: Uint8Array,
  fileToGenerate: string[],
  parameter = "target=ts",
): GeneratedFile[] {
  return generateFromProtos(
    fromBinary(FileDescriptorSetSchema, image).file,
    fileToGenerate,
    parameter,
  );
}

/** Like {@link generate}, for descriptors that were not built by buf. */
export function generateFromProtos(
  protoFile: FileDescriptorProto[],
  fileToGenerate: string[],
  parameter = "target=ts",
): GeneratedFile[] {
  const request = create(CodeGeneratorRequestSchema, {
    fileToGenerate,
    protoFile,
    parameter,
  });
  const registry = createFileRegistry(
    create(FileDescriptorSetSchema, { file: protoFile }),
  );
  return protocGenEs.run(request).file.map((file) => {
    const a = transformFileContent(file.content);
    const b = transformFileContentToTree(file.content, OPTION_B_RUNTIME);
    // protoc-gen-es names its output `<proto name without .proto>_pb.<ext>`.
    const source = fileToGenerate.find(
      (name) =>
        file.name.replace(/\.(d\.ts|ts|js)$/, "") ===
        `${name.replace(/\.proto$/, "")}_pb`,
    );
    const desc = source === undefined ? undefined : registry.getFile(source);
    const dependency = desc?.proto.dependency ?? [];
    // Number types are TypeScript; `.js` and `.d.ts` output gets none here.
    const typed = /(?<!\.d)\.ts$/.test(file.name);
    const manifest = (descriptorIndices: boolean) =>
      desc === undefined ? [] : indexManifest(desc, { descriptorIndices });
    return {
      name: file.name,
      content: {
        base64: file.content,
        a,
        "a-manifest": insertIndexManifest(a, manifest(true)),
        b,
        "b-index-manifest": insertIndexManifest(b, manifest(false)),
        "b-manifest": insertIndexManifest(b, manifest(true)),
        "b-index-manifest-numbers": transformFileContentToNames(
          file.content,
          NAMES_RUNTIME,
          {
            names: false,
            numberTypes: typed,
            manifest:
              desc === undefined
                ? []
                : withManifestHeader([
                    ...manifest(false),
                    ...oneofMemberManifest(desc),
                  ]),
          },
        ),
        "b-name-table-numbers": transformFileContentToNames(
          file.content,
          NAME_TABLE_RUNTIME,
          { names: true, numberTypes: typed },
        ),
        "b-names": transformFileContentInline(file.content, NAMES_RUNTIME, {
          dependency,
          numberTypes: false,
        }),
        "b-names-numbers": transformFileContentInline(
          file.content,
          NAMES_RUNTIME,
          { dependency, numberTypes: typed },
        ),
      },
    };
  });
}
