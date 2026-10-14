// End-to-end smoke test: builds nothing, expects `npm run build` first.
// Starts the bridge, opens the editor in headless Chromium, then drives it
// through MCP exactly as Claude Code or Codex would.
//
//   npm run build && npm run e2e
//
// Set CHROME_PATH if Playwright cannot find a Chromium on its own.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = 7899;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anim-e2e-'));
const bridge = spawn(process.execPath, ['bridge/server.mjs'], {
  env: { ...process.env, ANIMATOR_PORT: String(PORT), ANIMATOR_ROOTS: tmp, ANIMATOR_EXPORT_DIR: tmp, ANIMATOR_NO_BROWSER: '1' },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const cleanup = () => { bridge.kill(); fs.rmSync(tmp, { recursive: true, force: true }); };

try {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  await page.goto(`http://127.0.0.1:${PORT}/?bridge=ws://127.0.0.1:${PORT}/ws`);
  await page.waitForFunction(() => document.getElementById('ai-link')?.textContent?.includes('connected'), null, { timeout: 20000 });

  const client = new Client({ name: 'e2e', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)));
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, `${name} failed: ${JSON.stringify(r.content)}`);
    return r;
  };
  const text = (r) => JSON.parse(r.content[0].text);

  const status = text(await call('editor_status'));
  assert.equal(status.model.name, 'Mannequin');
  assert.equal(status.model.core_coverage, 1);

  const pose = text(await call('set_pose', { joints: { LeftArm: { rotation_deg: [0, 0, -75] } } }));
  assert.deepEqual(pose.joints.LeftArm.rotation_deg, [0, 0, -75]);
  // Arm lowered: the hand is now well below the shoulder.
  const full = text(await call('get_pose', { joints: ['LeftArm', 'LeftHand'] }));
  assert.ok(full.joints.LeftHand.position_m[1] < full.joints.LeftArm.position_m[1] - 0.3);

  await call('mirror_pose', { mode: 'left-to-right' });
  const mirrored = text(await call('get_pose', { joints: ['RightArm'] }));
  assert.deepEqual(mirrored.joints.RightArm.rotation_deg, [0, 0, 75]);

  const shot = await call('capture_view', { views: ['front', 'right'], size: 256 });
  assert.equal(shot.content.filter((c) => c.type === 'image').length, 2);

  const created = text(await call('create_animation', {
    name: 'Test raise', keys: [
      { time: 0, joints: { RightArm: { rotation_deg: [0, 0, 75] } } },
      { time: 1, joints: { RightArm: { rotation_deg: [0, 0, -60] } } },
    ], save: true,
  }));
  assert.deepEqual(created.keys, [0, 1]);
  const lib = text(await call('list_animations', { query: 'raise' }));
  assert.equal(lib.total, 1);

  const desc = text(await call('describe_animation', { fps: 2, joints: ['RightArm'] }));
  assert.equal(desc.frames.length, 3);
  assert.ok(Math.abs(desc.frames[2].joints.RightArm.rotation_deg[2] + 60) < 1);

  const sheet = await call('contact_sheet', { frames: 3 });
  assert.equal(sheet.content[1].type, 'image');

  await call('export', { kind: 'reference_pack' });
  await call('export', { kind: 'glb' });
  const written = fs.readdirSync(tmp);
  assert.ok(written.some((f) => f.endsWith('.zip')) && written.some((f) => f.endsWith('.glb')), `exports missing: ${written}`);

  // Paths outside the allowed folders are refused.
  const denied = await client.callTool({ name: 'load_model', arguments: { path: '/etc/passwd' } });
  assert.ok(denied.isError);

  await browser.close();
  console.log('e2e: all checks passed');
  cleanup();
} catch (e) {
  cleanup();
  console.error(e);
  process.exit(1);
}
