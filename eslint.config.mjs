import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next. `build/**` is deliberately
  // not among them: that directory is not a build output here, it holds the
  // script that shapes the Pages deploy artifact, and leaving it unlinted meant
  // the one file the deployment depends on was the one nothing checked.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
