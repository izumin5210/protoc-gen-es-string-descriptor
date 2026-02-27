import { protocGenEs } from "@bufbuild/protoc-gen-es/dist/cjs/src/protoc-gen-es-plugin.js";
import type { CodeGeneratorRequest, CodeGeneratorResponse } from "@bufbuild/protobuf/wkt";
import { transformFileContent } from "./transform.js";

export const plugin = {
  name: "protoc-gen-es-string-descriptor",
  version: "0.0.0",
  run(request: CodeGeneratorRequest): CodeGeneratorResponse {
    const response = protocGenEs.run(request);
    for (const file of response.file) {
      if (file.content) {
        file.content = transformFileContent(file.content);
      }
    }
    return response;
  },
};
