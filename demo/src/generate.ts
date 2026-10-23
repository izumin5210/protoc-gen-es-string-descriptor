import { create, fromBinary } from "@bufbuild/protobuf";
import {
  CodeGeneratorRequestSchema,
  FileDescriptorSetSchema,
} from "@bufbuild/protobuf/wkt";
import { protocGenEs } from "@bufbuild/protoc-gen-es/dist/cjs/src/protoc-gen-es-plugin.js";
import { transformFileContent } from "../../src/transform.js";
import { transformFileContentToTree } from "./option-b/transform.js";

export const ENCODINGS = ["base64", "a", "b"] as const;
export type Encoding = (typeof ENCODINGS)[number];

export const OPTION_B_RUNTIME = "option-b-runtime";

export interface GeneratedFile {
  name: string;
  content: Record<Encoding, string>;
}

/**
 * Run the real protoc-gen-es on a `buf build` image and derive the Option A
 * and Option B variants from its output, so all three embed exactly the
 * descriptor that protoc-gen-es strips and serializes.
 */
export function generate(
  image: Uint8Array,
  fileToGenerate: string[],
  parameter = "target=ts",
): GeneratedFile[] {
  const request = create(CodeGeneratorRequestSchema, {
    fileToGenerate,
    protoFile: fromBinary(FileDescriptorSetSchema, image).file,
    parameter,
  });
  return protocGenEs.run(request).file.map((file) => ({
    name: file.name,
    content: {
      base64: file.content,
      a: transformFileContent(file.content),
      b: transformFileContentToTree(file.content, OPTION_B_RUNTIME),
    },
  }));
}
