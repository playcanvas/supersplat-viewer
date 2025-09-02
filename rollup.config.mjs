import resolve from '@rollup/plugin-node-resolve';
import copy from 'rollup-plugin-copy';
import { string } from 'rollup-plugin-string';

export default [{
    input: 'src/index.js',
    output: {
        dir: 'dist',
        format: 'esm',
        sourcemap: true
    },
    plugins: [
        resolve(),
        copy({
            targets: [{
                src: 'src/index.html',
                dest: 'dist',
                transform: (contents) => {
                    return contents.toString().replace('<base href="">', `<base href="${process.env.BASE_HREF ?? ''}">`);
                }
            }, {
                src: 'src/index.css',
                dest: 'dist'
            }]
        })
    ]
}, {
    input: 'src/source.js',
    output: {
        file: 'dist/source.js',
        format: 'esm'
    },
    plugins: [
        string({
            include: ['src/index.html', 'src/index.css', 'src/index.js']
        })
    ]
}];
