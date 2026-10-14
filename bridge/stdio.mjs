#!/usr/bin/env node
// Stdio entry point for MCP clients that launch a command (Codex, Claude
// Desktop, older Claude Code setups). It forwards every request to the bridge
// at http://127.0.0.1:7878/mcp, starting the bridge in the background first if
// it is not already running.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ANIMATOR_PORT || 7878);
const URL_MCP = new URL(`http://127.0.0.1:${PORT}/mcp`);
const log = (...a) => console.error('[animation-editor]', ...a);

async function bridgeUp() {
  try { return (await fetch(`http://127.0.0.1:${PORT}/health`)).ok; } catch { return false; }
}

async function ensureBridge() {
  if (await bridgeUp()) return;
  log('starting bridge');
  spawn(process.execPath, [path.join(here, 'server.mjs')], { detached: true, stdio: 'ignore', env: process.env }).unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await bridgeUp()) return;
  }
  throw new Error(`Could not start the bridge on port ${PORT}.`);
}

async function connect() {
  await ensureBridge();
  const client = new Client({ name: 'animation-editor-stdio', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(URL_MCP));
  return client;
}

let clientPromise = connect();
async function client() {
  try { return await clientPromise; }
  catch (e) { clientPromise = connect(); throw e; }
}

const server = new Server({ name: 'animation-editor', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async (req) => (await client()).listTools(req.params));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const run = async () => (await client()).callTool(req.params, undefined, { timeout: 15 * 60 * 1000 });
  try { return await run(); }
  catch (e) {
    // The bridge may have restarted; reconnect once.
    log('call failed, reconnecting:', e?.message ?? e);
    clientPromise = connect();
    return run();
  }
});

await server.connect(new StdioServerTransport());
