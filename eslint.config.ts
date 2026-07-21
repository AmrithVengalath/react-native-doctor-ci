import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/", "coverage/", "node_modules/"],
  },
  eslint.configs.recommended,
  // Non-type-aware rules for every TS file (including root config files, which
  // are not part of the src tsconfig project).
  ...tseslint.configs.recommended,
  {
    // Type-aware linting only for source; uses the project service so no
    // explicit `project` glob is needed.
    files: ["src/**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeCheckedOnly],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // External JSON (npm registry, RN Directory, GitHub) is narrowed into typed
    // records by the source-boundary parsers (`parseNpmManifest`,
    // `parseGithubRepo`, `fetchLibraryDetail`), so the sources and the
    // orchestrator are fully type-checked. Only the MSW fixtures that *emulate*
    // those raw responses still hold hand-authored `any`.
    files: ["src/testing/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
    },
  },
  {
    // CI-only Node scripts (not part of the typechecked src project).
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly" },
    },
  },
);
