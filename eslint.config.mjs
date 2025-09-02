import playcanvasConfig from '@playcanvas/eslint-config';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import globals from 'globals';

export default [
    ...playcanvasConfig,
    {
        files: ['**/*.ts'],
        languageOptions: {
            parser: tsParser,
            globals: {
                ...globals.browser
            }
        },
        plugins: {
            '@typescript-eslint': tsPlugin
        },
        rules: {
            'import/default': 'off',
            'import/extensions': 'off',
            'import/no-unresolved': 'off',
            'jsdoc/require-param-type': 'off',
            'jsdoc/require-returns-type': 'off',
            'no-duplicate-imports': 'off'
        }
    },
    {
        files: ['**/*.mjs'],
        languageOptions: {
            globals: {
                ...globals.node
            }
        },
        rules: {
            'import/no-unresolved': 'off'
        }
    }
];
