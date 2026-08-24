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
        // These import build output — src/module imports the viewer files from public/, and
        // the tests import the bundled package from dist/ — which .gitignore excludes, so the
        // imports are absent on a clean checkout and the lint job does not build. The module
        // sources are type-checked via the ambient `declare module '*.css'` in types.d.ts.
        files: ['src/module/index.ts', 'src/module/render-html.ts', 'test/**/*.mjs'],
        rules: {
            'import-x/no-unresolved': 'off'
        }
    }
];
