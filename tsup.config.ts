import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm", "cjs"],
  target: "node20",
  dts: true,
  clean: true,
  sourcemap: true,
  // Keep the tree small; nothing here needs bundling of node built-ins.
  splitting: false,
});
