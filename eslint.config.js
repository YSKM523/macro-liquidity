import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  { ignores: ['node_modules/**', '.wrangler/**', 'dist/**', 'scripts/data/**'] },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-debugger': 'error',
      'no-duplicate-case': 'error',
      'no-fallthrough': 'error',
      'no-self-compare': 'error',
      'no-unreachable': 'error',
      'no-unused-private-class-members': 'error',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
    },
  },
];
