// Remote console for src/dev/remote.html, for devices Web Inspector cannot reach (a headset on a
// network that drops Bonjour). Two servers:
//   - the device side, https on the LAN address only, answers just the allowed device addresses:
//     it takes the page's console entries and results and hands it queued snippets, and serves
//     /upload, a page that copies files (recordings, photos) from the device into --uploads
//   - the control side, plain http on 127.0.0.1 only, is how this machine queues a snippet, waits
//     for its result, and reads the log; nothing on the network can queue code
//
//   node tools/remote-console.mjs serve --host 192.168.1.10 --allow 192.168.1.20 --cert cert.pem --key key.pem --log out.log [--uploads dir]
//   node tools/remote-console.mjs eval "app.graphicsDevice.width"     (or eval @file.js)
//   node tools/remote-console.mjs say "Look left"                     (no text: hide the panel)
//   node tools/remote-console.mjs log [--since <seq>]
//   node tools/remote-console.mjs status
import { randomUUID } from 'node:crypto';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { homedir } from 'node:os';
import path from 'node:path';

const [command, ...rest] = process.argv.slice(2);
const option = (name, fallback) => {
    const index = rest.indexOf(`--${name}`);
    return index >= 0 ? rest[index + 1] : fallback;
};
const controlPort = Number(option('control', 3446));

// an ipv4 client arrives on a dual-stack socket as ::ffff:a.b.c.d
const clientAddress = (req) => req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? '';

const readBody = (req, limit = 4 * 1024 * 1024) =>
    new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit) {
                reject(new Error('body too large'));
                req.destroy();
            } else chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });

// The upload page: files go one at a time, each as the raw body of a POST named in the query, so
// the server can stream it to disk whatever its size
const uploadPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Upload to the Mac</title>
<style>
    body { font: 18px -apple-system, system-ui, sans-serif; margin: 2em; max-width: 40em; }
    button, input { font: inherit; margin: 0.5em 0; }
    li { margin: 0.3em 0; }
</style>
</head>
<body>
<h1>Upload to the Mac</h1>
<p>Choose videos or photos. In the picker, Options can send originals rather than compatible copies.</p>
<input id="files" type="file" multiple accept="video/*,image/*,*/*" />
<br />
<button id="send">Upload</button>
<ul id="list"></ul>
<script>
    const list = document.getElementById('list');
    const sendOne = (file) =>
        new Promise((resolve) => {
            const item = document.createElement('li');
            item.textContent = file.name + ': 0%';
            list.append(item);
            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/upload?name=' + encodeURIComponent(file.name));
            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) item.textContent = file.name + ': ' + Math.round((100 * e.loaded) / e.total) + '%';
            };
            xhr.onload = () => {
                item.textContent = xhr.status === 200 ? file.name + ': saved as ' + JSON.parse(xhr.responseText).saved : file.name + ': failed (' + xhr.status + ')';
                resolve();
            };
            xhr.onerror = () => {
                item.textContent = file.name + ': failed (network)';
                resolve();
            };
            xhr.send(file);
        });
    document.getElementById('send').onclick = async () => {
        for (const file of document.getElementById('files').files) await sendOne(file);
    };
</script>
</body>
</html>
`;

// a plain file name (no directories), and a path in dir that does not overwrite an earlier upload
const uploadPath = (dir, name) => {
    const base = path.basename(name || 'upload').replace(/[^\w.\- ()]/g, '_') || 'upload';
    const ext = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    let candidate = path.join(dir, base);
    for (let i = 1; existsSync(candidate); i++) candidate = path.join(dir, `${stem} (${i})${ext}`);
    return candidate;
};

const serve = () => {
    const host = option('host');
    const port = Number(option('port', 3445));
    const cert = option('cert');
    const key = option('key');
    const logFile = option('log');
    const allow = new Set((option('allow') ?? '').split(',').filter(Boolean));
    if (!host || !cert || !key || !logFile || allow.size === 0) {
        throw new Error(
            'serve needs --host <lan address> --allow <device address[,...]> --cert <pem> --key <pem> --log <file>'
        );
    }
    // the page's origin: the https viewer server on the same host
    const origins = new Set([option('origin', `https://${host}:3443`)]);
    const uploadDir = option('uploads', path.join(homedir(), 'Downloads', 'vision-pro-uploads'));
    mkdirSync(uploadDir, { recursive: true });

    const entries = [];
    let seq = 0;
    const jobs = [];
    const pending = new Map();
    let waiter = null;
    let lastSeen = 0;

    const record = (entry) => {
        entry.seq = ++seq;
        entries.push(entry);
        if (entries.length > 5000) entries.splice(0, entries.length - 5000);
        appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
    };

    const deliver = () => {
        if (!waiter || jobs.length === 0) return;
        const { res, timer } = waiter;
        waiter = null;
        clearTimeout(timer);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(jobs.shift()));
    };

    const device = createHttpsServer({ cert: readFileSync(cert), key: readFileSync(key) }, async (req, res) => {
        const url = new URL(req.url, `https://${host}`);
        const origin = req.headers.origin;
        if (origin && origins.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
        if (!allow.has(clientAddress(req))) {
            console.log(`refused ${clientAddress(req)} ${req.method} ${url.pathname} origin ${origin}`);
            res.writeHead(403).end();
            return;
        }
        if (url.pathname !== '/next' || !lastSeen) {
            console.log(`${clientAddress(req)} ${req.method} ${url.pathname} origin ${origin}`);
        }
        lastSeen = Date.now();
        try {
            if (req.method === 'GET' && url.pathname === '/upload') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(uploadPage);
            } else if (req.method === 'POST' && url.pathname === '/upload') {
                // streamed to disk, never held in memory: a recording can be gigabytes
                const file = uploadPath(uploadDir, url.searchParams.get('name'));
                const out = createWriteStream(file);
                let bytes = 0;
                req.on('data', (chunk) => {
                    bytes += chunk.length;
                });
                const fail = (error) => {
                    out.destroy();
                    if (existsSync(file)) unlinkSync(file);
                    console.log(`upload failed ${file}: ${error?.message ?? error}`);
                    if (!res.headersSent) res.writeHead(500).end();
                };
                req.on('error', fail);
                req.on('aborted', () => fail(new Error('aborted')));
                out.on('error', fail);
                out.on('finish', () => {
                    console.log(`uploaded ${file} (${(bytes / 1048576).toFixed(1)} MiB)`);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ saved: path.basename(file), bytes }));
                });
                req.pipe(out);
            } else if (req.method === 'POST' && url.pathname === '/log') {
                for (const entry of JSON.parse(await readBody(req))) record(entry);
                res.writeHead(204).end();
            } else if (req.method === 'POST' && url.pathname === '/result') {
                const result = JSON.parse(await readBody(req));
                pending.get(result.id)?.(result);
                pending.delete(result.id);
                res.writeHead(204).end();
            } else if (req.method === 'GET' && url.pathname === '/next') {
                // one agent at a time: a new poll releases the previous one
                if (waiter) {
                    clearTimeout(waiter.timer);
                    waiter.res.writeHead(204).end();
                }
                const timer = setTimeout(() => {
                    if (waiter?.res === res) waiter = null;
                    res.writeHead(204).end();
                }, 25000);
                waiter = { res, timer };
                req.on('close', () => {
                    if (waiter?.res === res) {
                        clearTimeout(timer);
                        waiter = null;
                    }
                });
                deliver();
            } else {
                res.writeHead(404).end();
            }
        } catch (e) {
            res.writeHead(400).end(String(e?.message ?? e));
        }
    });
    device.on('tlsClientError', (error, socket) => {
        console.log(
            `tls error from ${socket.remoteAddress?.replace(/^::ffff:/, '')}: ${error.code ?? ''} ${error.message}`
        );
    });
    device.listen(port, host);

    const control = createHttpServer(async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const json = (status, body) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
        };
        if (req.method === 'POST' && url.pathname === '/eval') {
            const code = await readBody(req);
            const id = randomUUID();
            const timeout = Number(url.searchParams.get('timeout') ?? 60) * 1000;
            const result = await new Promise((resolve) => {
                const timer = setTimeout(() => {
                    pending.delete(id);
                    const queued = jobs.findIndex((job) => job.id === id);
                    if (queued >= 0) jobs.splice(queued, 1);
                    resolve({
                        id,
                        ok: false,
                        error: `no result in ${timeout / 1000} s${queued >= 0 ? ' (never picked up)' : ''}`
                    });
                }, timeout);
                pending.set(id, (value) => {
                    clearTimeout(timer);
                    resolve(value);
                });
                jobs.push({ id, code });
                deliver();
            });
            json(result.ok ? 200 : 500, result);
        } else if (req.method === 'GET' && url.pathname === '/log') {
            const since = Number(url.searchParams.get('since') ?? Math.max(0, seq - 100));
            json(
                200,
                entries.filter((entry) => entry.seq > since)
            );
        } else if (req.method === 'GET' && url.pathname === '/status') {
            json(200, {
                lastSeenSecondsAgo: lastSeen ? (Date.now() - lastSeen) / 1000 : null,
                agentWaiting: !!waiter,
                queued: jobs.length,
                entries: seq
            });
        } else {
            res.writeHead(404).end();
        }
    });
    control.listen(controlPort, '127.0.0.1');

    console.log(
        `device side https://${host}:${port} for ${[...allow].join(', ')}  control http://127.0.0.1:${controlPort}`
    );
    console.log(`page  https://${host}:3443/remote`);
    console.log(`upload https://${host}:${port}/upload  into ${uploadDir}`);
};

const client = async () => {
    const base = `http://127.0.0.1:${controlPort}`;
    if (command === 'eval' || command === 'say') {
        let code = rest.find((arg, i) => !arg.startsWith('--') && !rest[i - 1]?.startsWith('--'));
        // say: a message on the page's head-locked panel (window.hud), or none to take it away
        if (command === 'say') code = code ? `hud(${JSON.stringify(code)})` : 'hud()';
        if (!code) throw new Error('eval needs a snippet, or @file');
        if (code.startsWith('@')) code = readFileSync(code.slice(1), 'utf8');
        const response = await fetch(`${base}/eval?timeout=${option('timeout', 60)}`, { method: 'POST', body: code });
        const result = await response.json();
        console.log(JSON.stringify(result.ok ? result.value : result.error, null, 2));
        process.exitCode = result.ok ? 0 : 1;
    } else if (command === 'log') {
        const since = option('since');
        const response = await fetch(`${base}/log${since !== undefined ? `?since=${since}` : ''}`);
        for (const entry of await response.json()) {
            console.log(
                `${entry.seq} ${new Date(entry.time).toISOString().slice(11, 23)} ${entry.level.padEnd(9)} ${entry.message}`
            );
        }
    } else if (command === 'status') {
        console.log(JSON.stringify(await (await fetch(`${base}/status`)).json()));
    } else {
        throw new Error('use serve, eval, say, log or status');
    }
};

if (command === 'serve') serve();
else await client();
