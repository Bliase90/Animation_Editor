import * as THREE from 'three';
import './style.css';
import { Editor } from './editor';
import { BridgeClient } from './bridge-client';
import { ANIMATION_EXTENSIONS, MODEL_EXTENSIONS, extOf, loadAsset } from './loaders';
import { filesFromDrop, filesFromInput, packOf, saveBlob, toInput, canvasToBlob, safeName, type PickedFile } from './files';
import { buildGlb, buildReferencePack } from './exports';
import { MIXAMO_BONES } from './rig';
import type { ViewName } from './viewer';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const DEG = THREE.MathUtils.RAD2DEG;

const editor = new Editor($('viewport'));
(window as unknown as { editor: Editor }).editor = editor;

function status(text: string, error = false) {
  editor.setStatus(text);
  $('status').style.color = error ? 'var(--danger)' : '';
}

async function guard<T>(label: string, fn: () => Promise<T> | T): Promise<T | undefined> {
  try { return await fn(); }
  catch (e) { console.error(e); status(`${label}: ${(e as Error).message}`, true); return undefined; }
}

editor.on('status', () => { $('status').textContent = editor.status; });

// ------------------------------------------------------------------ model

function renderModelInfo() {
  const m = editor.model;
  if (!m) { $('model-info').textContent = 'No model'; return; }
  const cov = Math.round(editor.mappingCoverage() * 100);
  const mapped = m.byCanon.size;
  $('model-info').innerHTML = '';
  const name = document.createElement('div');
  name.textContent = m.name;
  name.style.fontWeight = '600';
  const info = document.createElement('div');
  info.className = 'muted';
  info.textContent = `${m.bones.length} bones · ${mapped} mapped · rig: ${m.rig.kind} · core coverage ${cov}%`;
  $('model-info').append(name, info);
  if (cov < 80) {
    const warn = document.createElement('div');
    warn.style.color = 'var(--danger)';
    warn.textContent = 'Some core bones are not recognised. Load a bone map so animations land correctly.';
    $('model-info').append(warn);
  }
}

function renderJointList() {
  const sel = $<HTMLSelectElement>('joint-list');
  sel.innerHTML = '';
  const m = editor.model;
  if (!m) return;
  const order = new Map(MIXAMO_BONES.map((b, i) => [b, i]));
  const entries = [...m.byCanon.entries()].sort((a, b) => (order.get(a[0]) ?? 999) - (order.get(b[0]) ?? 999));
  for (const [canon] of entries) {
    if (/_End$/.test(canon)) continue;
    const o = document.createElement('option');
    o.value = canon;
    o.textContent = canon;
    sel.append(o);
  }
}

editor.on('model', () => { renderModelInfo(); renderJointList(); });

async function openModelFiles(files: PickedFile[]) {
  const main = files.find((f) => MODEL_EXTENSIONS.includes(extOf(f.path)));
  if (!main) { status('Pick an FBX, GLB, glTF or .blend file.', true); return; }
  status(`Loading ${main.file.name}…`);
  const asset = await guard('Open model', async () => editor.openModel(await toInput(main, files)));
  if (asset) status(`Loaded ${main.file.name}${asset.clips.length ? ` with ${asset.clips.length} animation(s), added to the library` : ''}.`);
}

$('btn-open-model').onclick = () => $<HTMLInputElement>('file-model').click();
$<HTMLInputElement>('file-model').onchange = async (e) => {
  const input = e.target as HTMLInputElement;
  await openModelFiles(filesFromInput(input));
  input.value = '';
};
$('btn-mannequin').onclick = () => { editor.useMannequin(); status('Using the built-in mannequin.'); };
$<HTMLInputElement>('chk-joints').onchange = (e) => { editor.joints.visible = (e.target as HTMLInputElement).checked; };

$('btn-bonemap').onclick = () => $<HTMLInputElement>('file-bonemap').click();
$<HTMLInputElement>('file-bonemap').onchange = async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  await guard('Bone map', async () => {
    const map = JSON.parse(await file.text()) as Record<string, string>;
    const bad = Object.values(map).filter((v) => v && !MIXAMO_BONES.includes(v));
    if (bad.length) throw new Error(`Unknown Mixamo names: ${bad.slice(0, 5).join(', ')}`);
    await editor.setCustomBoneMap(Object.fromEntries(Object.entries(map).filter(([, v]) => v)));
    status(`Bone map loaded (${Object.keys(map).length} entries). Re-open the model and re-import packs that use it.`);
  });
};
$('btn-bonemap-template').onclick = () => {
  const m = editor.model;
  if (!m) return;
  const tpl = Object.fromEntries(m.rig.bones.map((b) => [b.name, b.canonical ?? '']));
  saveBlob(new Blob([JSON.stringify(tpl, null, 2)], { type: 'application/json' }), `${safeName(m.name)}_bonemap.json`);
};

// ------------------------------------------------------------------ library

let abort: AbortController | null = null;

async function importAnimationFiles(files: PickedFile[], fallbackPack: string) {
  const anims = files.filter((f) => ANIMATION_EXTENSIONS.includes(extOf(f.path)));
  if (!anims.length) { status('No FBX, GLB, glTF, BVH or .blend files found.', true); return; }
  abort = new AbortController();
  const bar = $('import-progress');
  bar.hidden = false;
  // Read files one at a time so a 2,000-file pack never sits in memory at once.
  const result = { clips: 0, errors: [] as string[] };
  for (let i = 0; i < anims.length && !abort.signal.aborted; i++) {
    const f = anims[i];
    (bar.firstElementChild as HTMLElement).style.width = `${(i / anims.length) * 100}%`;
    bar.querySelector('span')!.textContent = `${i + 1}/${anims.length} ${f.path}`;
    const input = await toInput(f, files);
    const r = await editor.importAnimations([{ ...input, source: packOf(f, fallbackPack), path: f.path }], undefined, abort.signal);
    result.clips += r.clips;
    result.errors.push(...r.errors);
  }
  bar.hidden = true;
  abort = null;
  status(`Imported ${result.clips} animation(s)${result.errors.length ? `, ${result.errors.length} file(s) skipped (see console)` : ''}.`, result.errors.length > 0 && result.clips === 0);
  if (result.errors.length) console.warn('Import problems:\n' + result.errors.join('\n'));
}

$('btn-import-files').onclick = () => $<HTMLInputElement>('file-anims').click();
$('btn-import-folder').onclick = () => $<HTMLInputElement>('folder-anims').click();
$('btn-import-cancel').onclick = () => abort?.abort();
for (const id of ['file-anims', 'folder-anims']) {
  $<HTMLInputElement>(id).onchange = async (e) => {
    const input = e.target as HTMLInputElement;
    const files = filesFromInput(input);
    input.value = '';
    await importAnimationFiles(files, 'Imported');
  };
}

const LIST_LIMIT = 400;
function renderLibrary() {
  const q = $<HTMLInputElement>('lib-search').value;
  const srcSel = $<HTMLSelectElement>('lib-source');
  const current = srcSel.value;
  srcSel.innerHTML = '<option value="">All packs</option>';
  for (const s of editor.library.sources()) {
    const o = document.createElement('option');
    o.value = s;
    o.textContent = `${s} (${editor.library.items.filter((m) => m.source === s).length})`;
    srcSel.append(o);
  }
  srcSel.value = editor.library.sources().includes(current) ? current : '';
  const items = editor.library.search(q, srcSel.value);
  const ul = $('lib-list');
  ul.innerHTML = '';
  for (const m of items.slice(0, LIST_LIMIT)) {
    const li = document.createElement('li');
    li.dataset.id = m.id;
    if (m.id === editor.clipId) li.classList.add('active');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = m.name;
    name.title = `${m.source} / ${m.file}`;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${m.duration.toFixed(1)}s`;
    li.append(name, meta);
    ul.append(li);
  }
  if (items.length > LIST_LIMIT) {
    const li = document.createElement('li');
    li.className = 'more';
    li.textContent = `…and ${items.length - LIST_LIMIT} more. Refine the search.`;
    ul.append(li);
  }
  $('lib-count').textContent = `${items.length} of ${editor.library.items.length}`;
}

$('lib-list').onclick = async (e) => {
  const li = (e.target as HTMLElement).closest('li');
  if (!li?.dataset.id) return;
  const id = li.dataset.id;
  status('Retargeting…');
  const meta = await guard('Play', () => editor.playLibraryClip(id));
  if (meta) status(`Playing ${meta.name} (${meta.source}).`);
};
$('lib-search').oninput = renderLibrary;
$('lib-source').onchange = renderLibrary;
$<HTMLInputElement>('chk-inplace').onchange = async (e) => {
  editor.inPlace = (e.target as HTMLInputElement).checked;
  if (editor.clipId) await guard('Play', () => editor.playLibraryClip(editor.clipId!, editor.playing));
};
$('btn-lib-delete').onclick = async () => {
  const src = $<HTMLSelectElement>('lib-source').value;
  if (!src) { status('Pick a pack in the dropdown first.', true); return; }
  const ids = editor.library.items.filter((m) => m.source === src).map((m) => m.id);
  if (!confirm(`Delete all ${ids.length} animations in "${src}" from the library? Your files on disk are not touched.`)) return;
  await editor.deleteClips(ids);
  status(`Deleted ${ids.length} animations.`);
};
editor.on('library', renderLibrary);
editor.on('clip', renderLibrary);

// ------------------------------------------------------------------ drag & drop

const vp = $('viewport');
vp.addEventListener('dragover', (e) => { e.preventDefault(); $('drop-hint').hidden = false; });
vp.addEventListener('dragleave', () => { $('drop-hint').hidden = true; });
vp.addEventListener('drop', async (e) => {
  e.preventDefault();
  $('drop-hint').hidden = true;
  const files = await filesFromDrop(e.dataTransfer!);
  const loadable = files.filter((f) => ANIMATION_EXTENSIONS.includes(extOf(f.path)));
  if (loadable.length === 1 && MODEL_EXTENSIONS.includes(extOf(loadable[0].path))) {
    // One file: open it as the character if it has a mesh, otherwise treat it as an animation.
    const asset = await guard('Open', async () => loadAsset(await toInput(loadable[0], files)));
    if (!asset) return;
    if (asset.hasMesh && confirm(`Open ${loadable[0].file.name} as the character?\n\nCancel adds its animations to the library instead.`)) {
      await openModelFiles(files);
      return;
    }
  }
  await importAnimationFiles(files, 'Imported');
});

// ------------------------------------------------------------------ viewport interaction

let downAt: { x: number; y: number } | null = null;
vp.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; });
vp.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return;
  if (editor.viewer.gizmo.dragging) return;
  const bone = editor.joints.pick(e);
  if (bone) editor.selectBone(bone);
});
document.querySelectorAll<HTMLButtonElement>('.views button').forEach((b) => {
  b.onclick = () => editor.viewer.setView(b.dataset.view as ViewName);
});

// ------------------------------------------------------------------ joint panel

const axes = ['x', 'y', 'z'] as const;

function renderJoint() {
  const bone = editor.selectedBone;
  $('joint-controls').hidden = !bone;
  $('joint-name').textContent = bone ? editor.boneLabel(bone) : '— click a joint';
  const sel = $<HTMLSelectElement>('joint-list');
  if (bone) sel.value = editor.boneLabel(bone);
  const isHips = bone && editor.boneLabel(bone) === 'Hips';
  $<HTMLButtonElement>('btn-gizmo-move').disabled = !isHips;
  $('btn-gizmo-rotate').classList.toggle('active', editor.viewer.gizmo.mode === 'rotate');
  $('btn-gizmo-move').classList.toggle('active', editor.viewer.gizmo.mode === 'translate');
  renderJointValues();
}

function renderJointValues() {
  const bone = editor.selectedBone;
  if (!bone || !editor.model) return;
  const e = new THREE.Euler().setFromQuaternion(editor.getDelta(bone), 'XYZ');
  const v = { x: e.x * DEG, y: e.y * DEG, z: e.z * DEG };
  for (const a of axes) {
    const r = $<HTMLInputElement>(`rot-${a}`), n = $<HTMLInputElement>(`num-${a}`);
    if (document.activeElement !== r) r.value = String(v[a]);
    if (document.activeElement !== n) n.value = v[a].toFixed(1);
  }
}

function applyJointInputs(source: 'rot' | 'num') {
  const bone = editor.selectedBone;
  if (!bone) return;
  const vals = axes.map((a) => parseFloat($<HTMLInputElement>(`${source}-${a}`).value) || 0);
  editor.setPose({ [editor.boneLabel(bone)]: { rotation_deg: vals } });
}

for (const a of axes) {
  $<HTMLInputElement>(`rot-${a}`).oninput = () => applyJointInputs('rot');
  $<HTMLInputElement>(`num-${a}`).onchange = () => applyJointInputs('num');
}
$('joint-list').onchange = (e) => editor.selectBone(editor.resolveBone((e.target as HTMLSelectElement).value));
$('btn-gizmo-rotate').onclick = () => { editor.viewer.gizmo.setMode('rotate'); renderJoint(); };
$('btn-gizmo-move').onclick = () => { editor.viewer.gizmo.setMode('translate'); renderJoint(); };
$('btn-reset-joint').onclick = () => { if (editor.selectedBone) editor.resetPose([editor.selectedBone]); };
$('btn-reset-pose').onclick = () => editor.resetPose();
$('btn-mirror-lr').onclick = () => editor.mirrorPose('left-to-right');
$('btn-mirror-rl').onclick = () => editor.mirrorPose('right-to-left');
$('btn-mirror-swap').onclick = () => editor.mirrorPose('swap');
editor.on('select', renderJoint);
editor.on('pose', () => { renderJointValues(); $('dirty').hidden = !(editor.dirty && editor.edit); });

// ------------------------------------------------------------------ timeline

const track = $('track');

function renderTime() {
  const d = editor.duration;
  const t = editor.time;
  $('time-label').textContent = `${t.toFixed(2)} / ${d.toFixed(2)} s`;
  $('playhead').style.left = d > 0 ? `${(t / d) * 100}%` : '0';
  $('btn-play').textContent = editor.playing ? '❚❚' : '▶';
  document.querySelectorAll<HTMLElement>('.key').forEach((k) => k.classList.toggle('current', Math.abs(parseFloat(k.dataset.t!) - t) < 1e-3));
}

function renderTrack() {
  const keys = $('keys');
  keys.innerHTML = '';
  const d = editor.duration;
  if (d > 0) {
    const step = d > 20 ? 5 : d > 6 ? 1 : 0.5;
    for (let s = 0; s <= d + 1e-6; s += step / 5) {
      const tick = document.createElement('div');
      const major = Math.abs(s / step - Math.round(s / step)) < 1e-6;
      tick.className = major ? 'tick major' : 'tick';
      tick.style.left = `${(s / d) * 100}%`;
      if (major) { const l = document.createElement('span'); l.textContent = `${+s.toFixed(2)}`; tick.append(l); }
      keys.append(tick);
    }
  }
  for (const k of editor.edit?.keys ?? []) {
    const el = document.createElement('div');
    el.className = 'key';
    el.dataset.t = String(k.time);
    el.title = `Key at ${k.time.toFixed(2)}s (drag to move)`;
    el.style.left = d > 0 ? `${(k.time / d) * 100}%` : '0';
    keys.append(el);
  }
  $('clip-label').textContent = editor.clip ? editor.clipLabel : 'No animation';
  renderTime();
}

function renderEdit() {
  const e = editor.edit;
  $('edit-fields').hidden = !e;
  $<HTMLButtonElement>('btn-edit-clip').disabled = !editor.clip || !!e;
  if (e) {
    const name = $<HTMLInputElement>('edit-name'), dur = $<HTMLInputElement>('edit-duration'), fps = $<HTMLInputElement>('edit-fps');
    if (document.activeElement !== name) name.value = e.name;
    if (document.activeElement !== dur) dur.value = String(e.duration);
    if (document.activeElement !== fps) fps.value = String(e.fps);
  }
  $('dirty').hidden = !(editor.dirty && e);
  renderTrack();
}

const timeAt = (clientX: number) => {
  const r = track.getBoundingClientRect();
  return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * editor.duration;
};
let dragKey: number | null = null;
track.addEventListener('pointerdown', (e) => {
  const target = e.target as HTMLElement;
  track.setPointerCapture(e.pointerId);
  editor.pause();
  if (target.classList.contains('key')) { dragKey = parseFloat(target.dataset.t!); editor.setTime(dragKey); return; }
  dragKey = null;
  editor.setTime(editor.snap(timeAt(e.clientX)));
});
track.addEventListener('pointermove', (e) => {
  if (!track.hasPointerCapture(e.pointerId)) return;
  if (dragKey === null) editor.setTime(editor.snap(timeAt(e.clientX)));
});
track.addEventListener('pointerup', (e) => {
  if (dragKey !== null) {
    const to = editor.snap(timeAt(e.clientX));
    if (Math.abs(to - dragKey) > 1e-4) { editor.moveKey(dragKey, to); editor.setTime(to); }
  }
  dragKey = null;
  track.releasePointerCapture(e.pointerId);
});

$('btn-play').onclick = () => (editor.playing ? editor.pause() : editor.play());
$<HTMLInputElement>('chk-loop').onchange = (e) => { editor.loop = (e.target as HTMLInputElement).checked; };
$<HTMLSelectElement>('sel-speed').onchange = (e) => { editor.speed = parseFloat((e.target as HTMLSelectElement).value); };
$('btn-new-clip').onclick = () => { editor.newEdit(); status('New clip started from the current pose. Pose the character, move the playhead and press K.'); };
$('btn-edit-clip').onclick = () => guard('Edit', () => { editor.editFromCurrentClip(5); status('Animation turned into keys every 5 frames. Adjust poses and press K.'); });
$('btn-key').onclick = () => { const t = editor.keyPose(); status(`Keyed pose at ${t.toFixed(2)}s.`); };
$('btn-del-key').onclick = () => editor.deleteKey(editor.snap(editor.time));
$('btn-save-clip').onclick = async () => {
  const meta = await guard('Save', () => editor.saveEditToLibrary());
  if (meta) status(`Saved "${meta.name}" to My clips.`);
};
$('btn-close-edit').onclick = () => {
  if (!editor.editSaved && !confirm('Close this clip without saving it to the library?')) return;
  editor.closeEdit();
};
$<HTMLInputElement>('edit-name').onchange = (e) => editor.setEditProps({ name: (e.target as HTMLInputElement).value });
$<HTMLInputElement>('edit-duration').onchange = (e) => editor.setEditProps({ duration: Math.max(0.1, parseFloat((e.target as HTMLInputElement).value) || 1) });
$<HTMLInputElement>('edit-fps').onchange = (e) => editor.setEditProps({ fps: Math.max(1, Math.round(parseFloat((e.target as HTMLInputElement).value) || 30)) });

editor.on('time', renderTime);
editor.on('clip', () => { renderTrack(); renderEdit(); });
editor.on('edit', renderEdit);

// ------------------------------------------------------------------ notes & export

const notes = $<HTMLTextAreaElement>('notes');
let notesTimer = 0;
notes.oninput = () => { clearTimeout(notesTimer); notesTimer = window.setTimeout(() => editor.setNotes(notes.value), 400); };
editor.on('notes', () => { if (document.activeElement !== notes) notes.value = editor.notes; });

$('btn-export-pack').onclick = () => guard('Export', async () => {
  status('Building reference pack…');
  const { name, bytes } = await buildReferencePack(editor);
  saveBlob(new Blob([bytes], { type: 'application/zip' }), name);
  status(`Saved ${name}.`);
});
$('btn-export-sheet').onclick = () => guard('Export', async () => {
  const sheet = editor.contactSheet(editor.clip ? 8 : 1, ['front', 'right', 'three_quarter'], 256);
  saveBlob(await canvasToBlob(sheet), `${safeName(editor.clipLabel || 'pose')}_sheet.png`);
});
$('btn-export-video').onclick = () => guard('Export', async () => {
  status('Recording one loop…');
  const blob = await editor.recordVideo('three_quarter');
  saveBlob(blob, `${safeName(editor.clipLabel)}.webm`);
  status('Video saved.');
});
$('btn-export-json').onclick = () => guard('Export', () => {
  const data = editor.clip ? editor.describeClip(30) : { notes: editor.notes, pose: editor.getPose() };
  saveBlob(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }), `${safeName(editor.clipLabel || 'pose')}.json`);
});
$('btn-export-glb').onclick = () => guard('Export', async () => {
  status('Exporting GLB…');
  const { name, bytes } = await buildGlb(editor);
  saveBlob(new Blob([bytes], { type: 'model/gltf-binary' }), name);
  status(`Saved ${name}.`);
});

$('btn-help').onclick = () => $<HTMLDialogElement>('help').showModal();

// ------------------------------------------------------------------ keyboard

window.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); editor.playing ? editor.pause() : editor.play(); }
  else if (e.key === 'k' || e.key === 'K') $('btn-key').click();
  else if (e.key === 'e' || e.key === 'E') { editor.viewer.gizmo.setMode('rotate'); renderJoint(); }
  else if ((e.key === 'w' || e.key === 'W') && editor.selectedBone && editor.boneLabel(editor.selectedBone) === 'Hips') { editor.viewer.gizmo.setMode('translate'); renderJoint(); }
  else if (e.key === 'Escape') editor.selectBone(null);
  else if (e.key === 'ArrowRight') { editor.pause(); editor.setTime(editor.snap(editor.time + 1 / (editor.edit?.fps ?? 30))); }
  else if (e.key === 'ArrowLeft') { editor.pause(); editor.setTime(editor.snap(editor.time - 1 / (editor.edit?.fps ?? 30))); }
});

// ------------------------------------------------------------------ boot

const bridge = new BridgeClient(editor, (connected) => {
  const pill = $('ai-link');
  pill.textContent = connected ? 'AI link: connected' : 'AI link: off';
  pill.className = `pill ${connected ? 'on' : 'off'}`;
});

editor.init().then(() => {
  renderModelInfo();
  renderLibrary();
  renderEdit();
  bridge.start();
  status('Ready. Open your model or start posing the mannequin.');
}).catch((e) => status(`Startup failed: ${(e as Error).message}`, true));
