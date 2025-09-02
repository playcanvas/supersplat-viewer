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
    input: 'module/index.ts',
    output: {
        file: 'dist/index.js',
        format: 'esm',
        sourcemap: true
    },
    plugins: [
        string({
            include: ['**/*.html', '**/*.css', '**/*.js']
        }),
        typescript({ noEmit: true }),
        copy({
            targets: [
                { src: 'module/index.d.ts', dest: 'dist' }
            ]
        })
    ]
}];
