import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["plugins/**/server/**", "node_modules/**", ".superpowers/**"]),
  ...tseslint.configs.recommended,
]);
