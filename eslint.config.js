import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

import n from 'eslint-plugin-n';
import importPlugin from 'eslint-plugin-import';

export default [
  {
    ignores: [
      'tmp/',
      'node_modules/',
      '.hls/',
      'logs/',
      'log/',
      'thumbs/',
      'data/',
      '.env',
      'dist/',
    ],
  },
  // Configuration for Node.js files
  {
    files: ['lib/**/*.js', 'server.js', 'tools/**/*.js'],
    plugins: {
      n: n,
    },
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'n/no-deprecated-api': 'error',
    },
  },
  // Configuration for Browser files
  {
    files: ['public/js/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        Hls: 'readonly',
      },
    },
  },
  // Global recommended rules
  js.configs.recommended,
  // Prettier config to disable conflicting rules
  prettierConfig,
  // Custom rules for the whole project
  {
    plugins: {
      import: importPlugin,
    },
    rules: {
      'no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-empty': 'warn',
      'import/no-unresolved': 'error',
    },
    settings: {
      'import/resolver': {
        node: { extensions: ['.js'] },
      },
    },
  },
];
