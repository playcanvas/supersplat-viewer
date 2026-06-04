import typescriptConfig from '@playcanvas/eslint-config/typescript';
import globals from 'globals';

export default [
    ...typescriptConfig,
    {
        files: ['**/*.ts'],
        languageOptions: {
            globals: {
                ...globals.browser
            }
        },
        rules: {
            'import-x/default': 'off',
            'import-x/extensions': 'off',
            'import-x/no-unresolved': 'off',
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
            'import-x/no-unresolved': 'off'
        }
    }
];
