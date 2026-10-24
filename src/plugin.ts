import {
  clone,
  create,
  createFileRegistry,
  type DescFile,
} from "@bufbuild/protobuf";
import {
  type CodeGeneratorRequest,
  CodeGeneratorRequestSchema,
  type CodeGeneratorResponse,
  FileDescriptorSetSchema,
} from "@bufbuild/protobuf/wkt";
import { protocGenEs } from "@bufbuild/protoc-gen-es/dist/cjs/src/protoc-gen-es-plugin.js";
import { indexManifest, insertIndexManifest } from "./manifest.js";
import { transformFileContent } from "./transform.js";

const INDEX_MANIFEST_OPTION = "index_manifest";

export const plugin = {
  name: "protoc-gen-es-string-descriptor",
  version: "0.0.0",
  run(request: CodeGeneratorRequest): CodeGeneratorResponse {
    const { parameter, withIndexManifest } = parseParameter(request.parameter);
    // protoc-gen-es rejects options it does not know.
    const esRequest = clone(CodeGeneratorRequestSchema, request);
    esRequest.parameter = parameter;
    const response = protocGenEs.run(esRequest);
    const sources = withIndexManifest ? filesByOutputBase(request) : undefined;
    for (const file of response.file) {
      if (!file.content) {
        continue;
      }
      file.content = transformFileContent(file.content);
      const source = sources?.get(file.name.replace(/\.(d\.ts|ts|js)$/, ""));
      if (source !== undefined) {
        file.content = insertIndexManifest(file.content, indexManifest(source));
      }
    }
    return response;
  },
};

function parseParameter(raw: string): {
  parameter: string;
  withIndexManifest: boolean;
} {
  let withIndexManifest = true;
  const rest: string[] = [];
  for (const part of raw === "" ? [] : raw.split(",")) {
    const [key, value = ""] = part.split("=", 2);
    if (key !== INDEX_MANIFEST_OPTION) {
      rest.push(part);
      continue;
    }
    if (!["true", "1", "false", "0"].includes(value)) {
      throw new Error(`invalid option "${part}": please provide true or false`);
    }
    withIndexManifest = value === "true" || value === "1";
  }
  return { parameter: rest.join(","), withIndexManifest };
}

/**
 * protoc-gen-es names its output `<proto name without .proto>_pb.<ext>`, so
 * the base name identifies the source file of every target (ts, js, dts).
 */
function filesByOutputBase(
  request: CodeGeneratorRequest,
): Map<string, DescFile> {
  const registry = createFileRegistry(
    create(FileDescriptorSetSchema, { file: request.protoFile }),
  );
  const files = new Map<string, DescFile>();
  for (const name of request.fileToGenerate) {
    const file = registry.getFile(name);
    if (file !== undefined) {
      files.set(`${name.replace(/\.proto$/, "")}_pb`, file);
    }
  }
  return files;
}
