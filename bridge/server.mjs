#!/usr/bin/env node
// Animation Editor bridge.
//
// One local process that:
//   * serves the built editor at http://127.0.0.1:7878/ (after `npm run build`)
//   * keeps a WebSocket open to the editor running in your browser
//   * exposes the editor to Claude Code, Codex and other MCP clients at
//     http://127.0.0.1:7878/mcp (Streamable HTTP). bridge/stdio.mjs offers the
//     same tools over stdio for clients that prefer launching a command.
//
// Everything binds to 127.0.0.1. Files are only read from or written to the
// folders listed in ANIMATOR_ROOTS (default: your home folder).

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools } from './tools.mjs';
import { findBlender, blendToGlb, blendBytesToGlb, NO_BLENDER } from './blender.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '..', 'dist');
export const PORT = Number(process.env.ANIMATOR_PORT || 7878);
const HOST = '127.0.0.1';
const DEV_URL = process.env.ANIMATOR_DEV_URL || 'http://127.0.0.1:5173/';

const ROOTS = (process.env.ANIMATOR_ROOTS || os.homedir()).split(path.delimiter).filter(Boolean).map((r) => path.resolve(r));
const EXPORT_DIR = path.resolve(process.env.ANIMATOR_EXPORT_DIR || path.join(os.homedir(), 'AnimationEditorExports'));
const ALLOWED_ORIGINS = new Set([
  `http://${HOST}:${PORT}`, `http://localhost:${PORT}`,
  'http://127.0.0.1:5173', 'http://localhost:5173',
  ...(process.env.ANIMATOR_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
]);
const ALLOWED_HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);

const log = (...a) => console.error('[bridge]', ...a);

// ------------------------------------------------------------------ paths

// Windows paths are case-insensitive.
const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

export function isInside(p, roots = [...ROOTS, EXPORT_DIR]) {
  const full = norm(p);
  return roots.map(norm).some((r) => full === r || full.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
}

function checkPath(p, what) {
  if (!p || typeof p !== 'string') throw new Error(`Give a ${what} path.`);
  const expanded = p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
  const full = path.resolve(expanded);
  if (!isInside(full)) throw new Error(`${full} is outside the allowed folders (${ROOTS.join(', ')}). Set ANIMATOR_ROOTS to allow it.`);
  return full;
}

// Short-lived download tokens so the browser never asks for arbitrary paths.
const tokens = new Map();
function fileUrl(full) {
  const token = crypto.randomBytes(16).toString('hex');
  tokens.set(token, { path: full, expires: Date.now() + 10 * 60 * 1000 });
  return `http://${HOST}:${PORT}/files/${token}`;
}

// ------------------------------------------------------------------ app link

let app = null;
const pending = new Map();
let openedBrowserAt = 0;

function appUrl() {
  return fs.existsSync(path.join(DIST, 'index.html')) ? `http://${HOST}:${PORT}/` : DEV_URL;
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch { /* no browser available */ }
}

async function waitForApp(ms) {
  const until = Date.now() + ms;
  while (!app && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
  return !!app;
}

/** Sends a command to the editor and waits for its answer. */
export async function callApp(method, params = {}, timeoutMs = 120000, waitForEditorMs = 20000) {
  if (!app) {
    // Open the editor once for the AI if nobody has it open.
    if (process.env.ANIMATOR_NO_BROWSER !== '1' && Date.now() - openedBrowserAt > 60000) {
      openedBrowserAt = Date.now();
      log('editor not connected, opening', appUrl());
      openBrowser(appUrl());
    }
    if (!(await waitForApp(waitForEditorMs))) {
      throw new Error(`The Animation Editor is not open. Open ${appUrl()} in a browser (run "npm run dev" or "npm start" in the Animation_Editor folder first).`);
    }
  }
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`The editor did not answer ${method} in time.`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    app.send(JSON.stringify({ id, method, params }));
  });
}

export const appConnected = () => !!app;

// ------------------------------------------------------------------ files for tools

const ANIM_EXT = new Set(['.fbx', '.glb', '.gltf', '.bvh', '.blend']);
const isBlend = (p) => path.extname(p).toLowerCase() === '.blend';

async function walk(dir, out = [], depth = 0) {
  if (depth > 12) return out;
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out, depth + 1);
    else if (ANIM_EXT.has(path.extname(e.name).toLowerCase())) out.push(full);
  }
  return out;
}

let importJob = null;

const files = {
  checkPath,
  fileUrl,
  exportDir: EXPORT_DIR,
  roots: ROOTS,
  appUrl,
  /** Lists animation files under a file or folder path. */
  async collect(p) {
    const full = checkPath(p, 'file or folder');
    const st = await fsp.stat(full);
    if (st.isFile()) return { base: path.dirname(full), list: [full], isDir: false };
    return { base: full, list: (await walk(full)).sort(), isDir: true };
  },
  importJob: () => importJob,
  blender: () => findBlender(),
  /** A download link the editor can load; .blend files are converted to GLB first. */
  async loadable(full, rel = path.basename(full), pack) {
    if (!isBlend(full)) return { url: fileUrl(full), path: rel, name: path.basename(full), pack };
    if (!findBlender()) throw new Error(NO_BLENDER);
    const glb = await blendToGlb(full);
    return { url: fileUrl(glb), path: rel, name: path.basename(full).replace(/\.blend$/i, '.glb'), pack };
  },
  async startImport(p, pack) {
    if (importJob && !importJob.done) throw new Error('An import is already running. Check import_status.');
    const { base, list, isDir } = await files.collect(p);
    if (!list.length) throw new Error(`No FBX, GLB, glTF, BVH or .blend files under ${p}.`);
    const packName = pack || (isDir ? path.basename(base) : 'Imported');
    const job = importJob = { pack: packName, total: list.length, done: false, processed: 0, imported: 0, errors: [], startedAt: Date.now() };
    (async () => {
      const batch = 20;
      for (let i = 0; i < list.length; i += batch) {
        const slice = [];
        for (const f of list.slice(i, i + batch)) {
          const rel = path.relative(base, f) || path.basename(f);
          try {
            slice.push(await files.loadable(f, rel, packName));
          } catch (e) {
            job.errors.push(`${rel}: ${e.message}`);
          }
        }
        if (!slice.length) { job.processed = Math.min(list.length, i + batch); continue; }
        try {
          const r = await callApp('import_animations', { files: slice }, 15 * 60 * 1000);
          job.imported += r.imported;
          job.errors.push(...r.errors);
        } catch (e) {
          job.errors.push(`${slice[0].path}…: ${e.message}`);
          if (!app) break;
        }
        job.processed = Math.min(list.length, i + batch);
      }
      job.done = true;
    })();
    return job;
  },
  async write(p, base64, filename) {
    const target = p ? checkPath(p, 'output') : path.join(EXPORT_DIR, filename);
    const final = p && (p.endsWith('/') || p.endsWith(path.sep) || (fs.existsSync(target) && fs.statSync(target).isDirectory())) ? path.join(target, filename) : target;
    await fsp.mkdir(path.dirname(final), { recursive: true });
    await fsp.writeFile(final, Buffer.from(base64, 'base64'));
    return final;
  },
};

// ------------------------------------------------------------------ http

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
}

async function handleMcp(req, res) {
  const server = new McpServer({ name: 'animation-editor', version: '0.1.0' }, {
    instructions: 'Drives the Animation Editor running in the user\'s browser: load their rigged character, browse and play their animation library, read and set joint rotations, build new clips from key poses, and capture images of the result. Joint names are Mixamo names without the "mixamorig" prefix. Rotations are degrees away from the T-pose in character axes (X = character left, Y = up, Z = forward). Always look at capture_view or contact_sheet images to check a pose before reporting it as done.',
  });
  registerTools(server, { callApp, appConnected, files });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  let body;
  if (req.method === 'POST') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { body = undefined; }
  }
  await transport.handleRequest(req, res, body);
}

const server = http.createServer(async (req, res) => {
  try {
    if (!ALLOWED_HOSTS.has(req.headers.host ?? '')) { res.writeHead(403).end('Forbidden host'); return; }
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (url.pathname === '/mcp') { await handleMcp(req, res); return; }
    if (req.method === 'OPTIONS') {
      cors(req, res);
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'content-type, x-filename' }).end();
      return;
    }
    if (url.pathname === '/convert/blend' && req.method === 'POST') {
      // Runs Blender, so only the editor itself may call it.
      if (!ALLOWED_ORIGINS.has(req.headers.origin ?? '')) { res.writeHead(403).end('Forbidden origin'); return; }
      cors(req, res);
      if (!findBlender()) { res.writeHead(501, { 'content-type': 'text/plain' }).end(NO_BLENDER); return; }
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > 2 * 1024 ** 3) { res.writeHead(413).end('File too large'); return; }
        chunks.push(c);
      }
      let name = String(req.headers['x-filename'] || 'upload.blend');
      if (!/\.blend$/i.test(name)) name += '.blend';
      try {
        const glb = await blendBytesToGlb(Buffer.concat(chunks), name);
        res.writeHead(200, { 'content-type': 'model/gltf-binary' }).end(glb);
      } catch (e) {
        res.writeHead(422, { 'content-type': 'text/plain' }).end(e.message);
      }
      return;
    }
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, app_connected: !!app, app_url: appUrl(), roots: ROOTS, export_dir: EXPORT_DIR, blender: findBlender() }));
      return;
    }
    if (url.pathname.startsWith('/files/')) {
      cors(req, res);
      const t = tokens.get(url.pathname.slice(7));
      if (!t || t.expires < Date.now()) { res.writeHead(404).end('Unknown or expired file link'); return; }
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      fs.createReadStream(t.path).pipe(res);
      return;
    }
    // Static editor build.
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const full = path.resolve(DIST, rel);
    if (!full.startsWith(DIST + path.sep) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      if (!fs.existsSync(path.join(DIST, 'index.html'))) {
        res.writeHead(200, { 'content-type': 'text/plain' }).end(`Animation Editor bridge is running.\nThe editor is not built: run "npm run dev" and open ${DEV_URL}, or run "npm start".\nMCP endpoint: http://${HOST}:${PORT}/mcp\n`);
      } else res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] ?? 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    log('request failed', e);
    if (!res.headersSent) res.writeHead(500).end(String(e?.message ?? e));
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname !== '/ws' || !ALLOWED_HOSTS.has(req.headers.host ?? '') || !ALLOWED_ORIGINS.has(req.headers.origin ?? '')) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (app) app.close(4000, 'Replaced by a newer editor window');
    app = ws;
    log('editor connected');
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const p = msg.id && pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg.result);
    });
    ws.on('close', () => {
      if (app === ws) { app = null; log('editor disconnected'); }
    });
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { log(`port ${PORT} is busy; another bridge is probably running already.`); process.exit(0); }
  throw e;
});
server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}  (MCP: /mcp, editor: ${appUrl()})`);
  log(`allowed folders: ${ROOTS.join(', ')}  exports: ${EXPORT_DIR}`);
  log(findBlender() ? `Blender: ${findBlender()} (.blend files supported)` : 'Blender not found: .blend files need Blender installed or BLENDER_PATH set');
});
