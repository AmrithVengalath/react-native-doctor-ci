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
    // The data-source boundary parses inherently-untyped external JSON (npm registry,
    // RN Directory, GitHub) and the MSW fixtures that emulate it, so `any` is
    // unavoidable here. Typed runtime validation is a deliberate future hardening step
    // (see DECISIONS ADR); until then these files opt out of the unsafe-any family.
    // Public, typed surfaces (types.ts, the Phase 2+ policy engine) stay strict.
    files: ["src/sources/**/*.ts", "src/enrich.ts", "src/concurrency.ts", "src/testing/**/*.ts"],
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
);
