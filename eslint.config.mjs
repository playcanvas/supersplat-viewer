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
        }
    },
    {
        files: ['**/*.mjs'],
        languageOptions: {
            globals: {
                ...globals.node
            }
        }
    },
    {
        // preserve existing module initialization order
        files: [
            'src/cameras/anim-controller.ts',
            'src/cameras/fly-controller.ts',
            'src/cameras/walk-controller.ts',
            'src/index.ts'
        ],
        rules: {
            'import-x/order': 'off'
        }
    },
    {
        // These import the built viewer files from public/, which the build generates and
        // .gitignore excludes — so they are absent on a clean checkout, and the lint job does
        // not build. Type-checked via the ambient `declare module '*.css'` in types.d.ts.
        files: ['src/module/index.ts', 'src/module/render-html.ts'],
        rules: {
            'import-x/no-unresolved': 'off'
        }
    }
];
