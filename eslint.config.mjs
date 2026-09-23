import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...nextVitals,
  ...nextTypescript,
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "out/**",
      ".android-build/**",
      "android/**",
      "artifacts/**",
      "services/**/.venv/**",
      "services/**/.pytest_cache/**",
      "services/**/pytest-cache-files-*/**",
      "services/**/__pycache__/**",
    ],
  },
];

export default eslintConfig;
