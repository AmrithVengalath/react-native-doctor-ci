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
);
