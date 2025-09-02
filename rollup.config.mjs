import resolve from '@rollup/plugin-node-resolve';
import copy from 'rollup-plugin-copy';
import { string } from 'rollup-plugin-string';

export default [{
    input: 'src/index.js',
    output: {
        dir: 'public',
        format: 'esm',
        sourcemap: true
    },
    plugins: [
        resolve(),
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
    input: 'src/module.js',
    output: {
        dir: 'dist',
        format: 'esm',
        sourcemap: true
    },
    plugins: [
        string({
            include: ['src/index.html', 'src/index.css', 'src/index.js']
        })
    ]
}];
