import type {
  CodeGeneratorRequest,
  CodeGeneratorResponse,
} from "@bufbuild/protobuf/wkt";
import { protocGenEs } from "@bufbuild/protoc-gen-es/dist/cjs/src/protoc-gen-es-plugin.js";
import { transformFileContent } from "./transform.js";

export const plugin = {
  name: "protoc-gen-es-string-descriptor",
  version: "0.0.0",
  run(request: CodeGeneratorRequest): CodeGeneratorResponse {
    const response = protocGenEs.run(request);
    // protoc-gen-es names its output `<proto name without .proto>_pb.<ext>`.
    const sources = new Map(
      request.protoFile.map((f) => [f.name.replace(/\.proto$/, "_pb"), f]),
    );
    for (const file of response.file) {
      if (file.content) {
        const ext = /\.(d\.ts|ts|js)$/.exec(file.name)?.[1];
        file.content = transformFileContent(file.content, {
          source: sources.get(file.name.slice(0, -(ext?.length ?? 0) - 1)),
          // Duplicate-number guard types are erased from JavaScript, so `.js` gets none.
          numberTypes: ext !== "js",
        });
      }
    }
    return response;
  },
};
