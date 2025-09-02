import resolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import copy from 'rollup-plugin-copy';
import { string } from 'rollup-plugin-string';

export default [{
    input: 'src/index.ts',
    output: {
        dir: 'public',
        format: 'esm',
        sourcemap: true
    },
    plugins: [
        resolve(),
        typescript(),
        copy({
            targets: [{
                src: 'src/index.html',
                dest: 'public',
                transform: (contents) => {
                    return contents.toString().replace('<base href="">', `<base href="${process.env.BASE_HREF ?? ''}">`);
                }
            }, {
                src: 'src/index.css',
                dest: 'public'
            }]
        })
    ]
}, {
    input: 'src/module.ts',
    output: {
        file: 'dist/index.js',
        format: 'esm',
        sourcemap: true
    },
    plugins: [
        string({
            include: ['src/index.html', 'src/index.css', 'src/index.ts'],
            transform: (contents) => {
                return contents.toString().replace('<base href="">', `<base href="${process.env.BASE_HREF ?? ''}">`);
            }
        }),
        typescript(),
        copy({
            targets: [
                { src: 'src/module.d.ts', dest: 'dist', rename: 'index.d.ts' }
            ]
        })
    ]
}];
