import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      // Generated code that tests evaluate imports the runtime by package
      // name; resolve it to the source instead of a build.
      {
        find: /^protoc-gen-es-string-descriptor$/,
        replacement: fileURLToPath(new URL("src/runtime.ts", import.meta.url)),
      },
    ],
  },
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      exclude: ["**/*.test.ts", "**/testdata", "examples", "**/dist"],
    },
  },
});
