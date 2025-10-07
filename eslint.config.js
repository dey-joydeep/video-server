import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

export default [
    { ignores: ['tmp/'] },
    // Configuration for Node.js files
    {
        files: ['lib/**/*.js', 'server.js', 'tools/**/*.js'],
        languageOptions: {
            globals: {
                ...globals.node,
            },
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
        rules: {
            'no-unused-vars': [
                'warn',
                { argsIgnorePattern: '^_$', varsIgnorePattern: '^_$' },
            ],
            'no-empty': 'warn',
        },
    },
];
