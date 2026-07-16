// @ts-check
/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
  ],
  env: {
    node: true,
    es2020: true,
  },
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    project: ['./src/extension/tsconfig.json', './src/webview/tsconfig.json'],
  },
  overrides: [
    // Extension host — CJS, no DOM
    {
      files: ['src/extension/**/*.ts'],
      env: {
        node: true,
        browser: false,
      },
      rules: {
        '@typescript-eslint/no-var-requires': 'off',
      },
    },
    // Webview — ESM, DOM
    {
      files: ['src/webview/**/*.{ts,tsx}'],
      env: {
        browser: true,
        node: false,
      },
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    // Shared — no environment-specific APIs
    {
      files: ['src/shared/**/*.ts'],
      env: {
        node: false,
        browser: false,
      },
    },
    // Config files — CJS
    {
      files: ['*.cjs', '*.config.{js,mjs}', 'esbuild.config.mjs'],
      rules: {
        '@typescript-eslint/no-var-requires': 'off',
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-call': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
      },
    },
  ],
  rules: {
    '@typescript-eslint/explicit-function-return-type': [
      'warn',
      { allowExpressions: true, allowTypedFunctionExpressions: true },
    ],
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    eqeqeq: ['error', 'always'],
  },
  ignorePatterns: ['dist/', 'node_modules/', '*.vsix'],
};
