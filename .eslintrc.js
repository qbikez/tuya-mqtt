// eslint-disable-next-line no-undef
module.exports = {
  root: true,
  env: {
    browser: true,
    es2021: true,
  },
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  overrides: [],
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    // project: "./tsconfig.json",
    // tsconfigRootDir: __dirname,
  },
  rules: {
    "no-case-declarations": "off",
    "@typescrit-eslint/no-explicit-any": "off"
  },
  // "ignorePatterns": ["**/*.js"],
};
