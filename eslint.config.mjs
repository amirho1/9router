import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = defineConfig([
  ...nextVitals,
  // Schema preparation must never silently fail because of an undefined name.
  {
    files: [
      "open-sse/translator/formats/gemini.js",
      "open-sse/translator/concerns/geminiSchema.js",
      "open-sse/translator/concerns/schemaBudget.js",
      "open-sse/translator/request/openai-to-gemini.js",
      "open-sse/config/schemaCompatibility.js",
      "open-sse/utils/schemaErrors.js",
    ],
    rules: { "no-undef": "error" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
