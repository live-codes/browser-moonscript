// Minimal static file server for local development.
//
// This serves files and does no computation: nothing is compiled, uploaded or
// fetched on the user's behalf. It exists because the page is an ES module that
// imports a WebAssembly compiler, and browsers do not allow either on a
// `file://` origin. Any static host works just as well.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const port = Number(process.argv[2] || process.env.PORT || 8131);

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const requested = decodeURIComponent(url.pathname);
  const target = resolve(join(root, normalize(requested === '/' ? '/index.html' : requested)));

  // Refuse anything that escapes the served directory.
  if (target !== root && !target.startsWith(root + sep)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const body = await readFile(target);
    response.writeHead(200, {
      'Content-Type': types[extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(body);
  } catch (err) {
    const status = err.code === 'ENOENT' || err.code === 'EISDIR' ? 404 : 500;
    response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(status === 404 ? 'Not found' : 'Server error');
  }
});

server.listen(port, () => {
  console.log(`Serving ${root} on http://localhost:${port}/`);
});
