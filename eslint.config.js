import config from "@echristian/eslint-config"

export default config(
  {
    ignores: ["claude-plugin/**", ".opencode/**"],
    prettier: {
      plugins: ["prettier-plugin-packagejson"],
    },
  },
  {
    files: [
      "tests/multi/*.test.ts",
      "tests/multi/*.test.tsx",
      "tests/multi/*.test.js",
      "tests/multi/*.test.jsx",
    ],
    rules: {
      "max-lines-per-function": [
        "error",
        { max: 400, skipBlankLines: true, skipComments: true },
      ],
      "require-atomic-updates": "off",
    },
  },
)
