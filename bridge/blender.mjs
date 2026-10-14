// Finds a local Blender install and uses it to turn .blend files into GLB,
// since browsers cannot read .blend directly.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, 'blend_to_glb.py');
const CACHE = path.join(os.tmpdir(), 'animation-editor-blend');

const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** Highest-versioned "Blender x.y" folder inside `dir` that holds the executable. */
function newestIn(dir, exe) {
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return null; }
  const found = entries
    .filter((e) => /blender/i.test(e))
    .map((e) => ({ e, v: (e.match(/(\d+)\.(\d+)/) || [0, 0, 0]).slice(1).map(Number) }))
    .sort((a, b) => b.v[0] - a.v[0] || b.v[1] - a.v[1])
    .map(({ e }) => path.join(dir, e, exe))
    .find(exists);
  return found ?? null;
}

function onPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']) {
      const p = path.join(dir, name + ext);
      if (exists(p)) return p;
    }
  }
  return null;
}

let cached;

/** Path to the Blender executable, or null. BLENDER_PATH wins. */
export function findBlender() {
  if (cached !== undefined) return cached;
  const env = process.env.BLENDER_PATH;
  if (env) return (cached = exists(env) ? env : null);
  let found = onPath('blender');
  if (!found && process.platform === 'win32') {
    const drives = ['C', 'D', 'E', 'F'];
    for (const d of drives) {
      found = newestIn(`${d}:\\Program Files\\Blender Foundation`, 'blender.exe')
        ?? [`${d}:\\Program Files (x86)\\Steam\\steamapps\\common\\Blender\\blender.exe`,
          `${d}:\\SteamLibrary\\steamapps\\common\\Blender\\blender.exe`,
          `${d}:\\Steam\\steamapps\\common\\Blender\\blender.exe`].find(exists) ?? null;
      if (found) break;
    }
  }
  if (!found && process.platform === 'darwin') {
    found = ['/Applications/Blender.app/Contents/MacOS/Blender', path.join(os.homedir(), 'Applications/Blender.app/Contents/MacOS/Blender')].find(exists) ?? null;
  }
  if (!found && process.platform === 'linux') {
    found = ['/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender', '/var/lib/flatpak/exports/bin/org.blender.Blender'].find(exists) ?? null;
  }
  return (cached = found);
}

export const NO_BLENDER = 'Blender was not found on this computer, so .blend files cannot be opened. Install Blender from https://www.blender.org/download/ (or set BLENDER_PATH to blender.exe), then restart the editor. Alternatively export the file from Blender as FBX or GLB.';

// One conversion at a time: Blender is heavy.
let queue = Promise.resolve();

/**
 * Converts `blendPath` to GLB and returns the GLB path. Results are cached by
 * file path, size and modification time.
 */
export function blendToGlb(blendPath) {
  const run = async () => {
    const blender = findBlender();
    if (!blender) throw new Error(NO_BLENDER);
    const st = await fsp.stat(blendPath);
    const key = crypto.createHash('sha1').update(`${path.resolve(blendPath)}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16);
    await fsp.mkdir(CACHE, { recursive: true });
    const out = path.join(CACHE, `${key}.glb`);
    if (exists(out)) return out;
    const tmpOut = `${out}.${process.pid}.tmp.glb`;
    const stdout = await new Promise((resolve, reject) => {
      execFile(blender, ['--background', '--factory-startup', '--python', SCRIPT, '--', blendPath, tmpOut],
        { timeout: 5 * 60 * 1000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
        (err, so, se) => {
          if (err && !exists(tmpOut)) {
            const tail = `${so}\n${se}`.trim().split('\n').slice(-8).join('\n');
            reject(new Error(`Blender could not convert ${path.basename(blendPath)}:\n${tail}`));
          } else resolve(so);
        });
    });
    if (!exists(tmpOut)) throw new Error(`Blender produced no output for ${path.basename(blendPath)}.\n${String(stdout).slice(-500)}`);
    await fsp.rename(tmpOut, out);
    return out;
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

/** Converts uploaded .blend bytes (from the browser) and returns GLB bytes. */
export async function blendBytesToGlb(bytes, name = 'upload.blend') {
  await fsp.mkdir(CACHE, { recursive: true });
  const hash = crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 16);
  const safe = name.replace(/[^\w.\-]+/g, '_').replace(/(\.blend)?$/i, '.blend');
  const src = path.join(CACHE, `${hash}-${safe}`);
  if (!exists(src)) await fsp.writeFile(src, bytes);
  return fsp.readFile(await blendToGlb(src));
}
