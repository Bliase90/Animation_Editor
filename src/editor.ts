import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { Viewer, type ViewName } from './viewer';
import { JointMarkers } from './joints';
import { Library, kv, type ClipMeta } from './library';
import { extractRig, retargetClip, sameRig, collectBones, type RigInfo } from './retarget';
import { loadAsset, type FileInput, type LoadedAsset } from './loaders';
import { createMannequin } from './mannequin';
import { mirrorName, coverage, mapBones } from './rig';

const DEG = THREE.MathUtils.RAD2DEG;
const RAD = THREE.MathUtils.DEG2RAD;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r1 = (n: number) => Math.round(n * 10) / 10;

export interface ModelState {
  name: string;
  root: THREE.Object3D;
  /** Normalises scale and puts the feet on the grid. Its frame is "character space". */
  container: THREE.Group;
  bones: THREE.Bone[];
  byName: Map<string, THREE.Bone>;
  byCanon: Map<string, THREE.Bone>;
  canonOf: Map<THREE.Bone, string>;
  index: Map<THREE.Bone, number>;
  rig: RigInfo;
  restCharQ: THREE.Quaternion[];
  parentRestCharQ: THREE.Quaternion[];
  restHipsChar: THREE.Vector3 | null;
  height: number;
}

/** One full-body key in the user's own clip. */
export interface PoseKey {
  time: number;
  /** Local quaternion per bone name. */
  q: Record<string, number[]>;
  /** Local hips position. */
  hips?: number[];
}

export interface EditClip {
  name: string;
  duration: number;
  fps: number;
  keys: PoseKey[];
}

/** Pose of one joint as exchanged with the UI and the AI tools. */
export interface JointPose {
  /** Rotation away from the rest (T-)pose, in degrees, XYZ order, in character axes. */
  rotation_deg: number[];
}

export interface PoseReport {
  time: number;
  /** X = character's left, Y = up, Z = forward. Units: metres. */
  axes: string;
  joints: Record<string, JointPose & { position_m: number[] }>;
  hips_offset_m: number[];
}

export type EditorEvent = 'model' | 'clip' | 'time' | 'pose' | 'library' | 'edit' | 'select' | 'notes' | 'status';

export class Editor extends EventTarget {
  readonly viewer: Viewer;
  readonly library = new Library();
  readonly joints: JointMarkers;
  model: ModelState | null = null;
  mixer: THREE.AnimationMixer | null = null;
  action: THREE.AnimationAction | null = null;
  clip: THREE.AnimationClip | null = null;
  clipLabel = '';
  clipId: string | null = null;
  playing = false;
  speed = 1;
  loop = true;
  inPlace = false;
  edit: EditClip | null = null;
  /** False while the user's clip has changes that are not in the library. */
  editSaved = true;
  /** True after a joint was moved and not yet keyed. */
  dirty = false;
  notes = '';
  status = '';
  customBoneMap: Record<string, string> = {};
  private retargetCache = new Map<string, THREE.AnimationClip>();

  constructor(host: HTMLElement) {
    super();
    this.viewer = new Viewer(host);
    this.joints = new JointMarkers(this.viewer);
    this.viewer.addFrameListener((dt) => this.frame(dt));
    this.viewer.gizmo.addEventListener('objectChange', () => { this.dirty = true; this.emit('pose'); });
    this.viewer.gizmo.addEventListener('mouseDown', () => this.pause());
  }

  emit(type: EditorEvent) { this.dispatchEvent(new Event(type)); }
  on(type: EditorEvent, fn: () => void) { this.addEventListener(type, fn); }

  setStatus(text: string) { this.status = text; this.emit('status'); }

  async init() {
    await this.library.load();
    this.notes = (await kv.get<string>('notes')) ?? '';
    this.customBoneMap = (await kv.get<Record<string, string>>('boneMap')) ?? {};
    this.edit = (await kv.get<EditClip>('edit')) ?? null;
    const last = await kv.get<{ name: string; data: ArrayBuffer }>('lastModel');
    let loaded = false;
    if (last) {
      try { await this.openModel({ name: last.name, data: last.data }, false); loaded = true; }
      catch (e) { console.warn('Could not reopen last model', e); }
    }
    if (!loaded) this.useMannequin();
    this.emit('library');
    this.emit('notes');
    if (this.edit) this.applyEdit();
  }

  // ---------------------------------------------------------------- model

  useMannequin() {
    this.setModel({ fileName: 'Mannequin', scene: createMannequin(), clips: [], hasMesh: true });
  }

  /** Loads a model file. Any clips inside it are also added to the library. */
  async openModel(input: FileInput, remember = true) {
    const asset = await loadAsset(input);
    if (!asset.hasMesh) throw new Error(`${input.name} has no mesh. Import it as an animation instead.`);
    this.setModel(asset);
    if (asset.clips.length) await this.addClipsToLibrary(asset, `Model: ${asset.fileName}`, asset.fileName);
    if (remember && !input.siblings?.size) await kv.set('lastModel', { name: input.name, data: input.data });
    return asset;
  }

  setModel(asset: LoadedAsset) {
    if (this.model) this.viewer.stage.remove(this.model.container);
    this.stopClip();
    const root = asset.scene;
    const container = new THREE.Group();
    container.add(root);
    // Skinned meshes are often culled wrongly once the skeleton moves.
    root.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.frustumCulled = false; });

    const bones = collectBones(root);
    if (!bones.length) throw new Error(`${asset.fileName} has no skeleton. Rig it with Mixamo first.`);
    const rig = extractRig(root, this.customBoneMap);

    // Normalise: about 1.8 m tall, feet on the grid, centred.
    container.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const height = size.y > 1e-6 ? size.y : 1.8;
    const s = 1.8 / height;
    container.scale.setScalar(s);
    const center = box.getCenter(new THREE.Vector3());
    root.position.x -= center.x;
    root.position.z -= center.z;
    root.position.y -= box.min.y;
    container.updateMatrixWorld(true);

    const byName = new Map(bones.map((b) => [b.name, b]));
    const byCanon = new Map<string, THREE.Bone>();
    const canonOf = new Map<THREE.Bone, string>();
    rig.bones.forEach((rb, i) => { if (rb.canonical) { byCanon.set(rb.canonical, bones[i]); canonOf.set(bones[i], rb.canonical); } });
    const index = new Map(bones.map((b, i) => [b, i]));

    // Rest rotations in character space (= container frame).
    const containerInvQ = container.getWorldQuaternion(new THREE.Quaternion()).invert();
    const restCharQ = bones.map((b) => containerInvQ.clone().multiply(b.getWorldQuaternion(new THREE.Quaternion())));
    const parentRestCharQ = bones.map((b) => containerInvQ.clone().multiply(b.parent!.getWorldQuaternion(new THREE.Quaternion())));
    const hips = byCanon.get('Hips');
    const restHipsChar = hips ? container.worldToLocal(hips.getWorldPosition(new THREE.Vector3())) : null;

    this.model = { name: asset.fileName, root, container, bones, byName, byCanon, canonOf, index, rig, restCharQ, parentRestCharQ, restHipsChar, height };
    this.viewer.stage.add(container);
    this.mixer = new THREE.AnimationMixer(root);
    this.retargetCache.clear();
    this.joints.setBones(bones, (b) => canonOf.get(b) ?? null, 0.022);
    this.selectBone(null);
    this.viewer.setView('front');
    this.emit('model');
  }

  mappingCoverage(): number {
    if (!this.model) return 0;
    return coverage(Object.fromEntries(this.model.rig.bones.map((b) => [b.name, b.canonical])));
  }

  async setCustomBoneMap(map: Record<string, string>) {
    this.customBoneMap = map;
    await kv.set('boneMap', map);
  }

  // ---------------------------------------------------------------- library

  async addClipsToLibrary(asset: LoadedAsset, source: string, file: string, skipExisting = false): Promise<ClipMeta[]> {
    if (!asset.clips.length) return [];
    const rig = extractRig(asset.scene, this.customBoneMap);
    const added: ClipMeta[] = [];
    for (const clip of asset.clips) {
      if (clip.duration <= 0 || !clip.tracks.length) continue;
      const id = `${source}::${file}::${clip.name}`;
      if (skipExisting && this.library.has(id)) continue;
      added.push(await this.library.add(clip, rig, source, file));
      this.retargetCache.delete(id);
    }
    this.emit('library');
    return added;
  }

  /** Imports many animation files, one at a time, reporting progress. */
  async importAnimations(files: (FileInput & { source: string; path: string })[], onProgress?: (done: number, total: number, name: string) => void, signal?: AbortSignal) {
    const errors: string[] = [];
    let clips = 0;
    for (let i = 0; i < files.length; i++) {
      if (signal?.aborted) break;
      const f = files[i];
      onProgress?.(i, files.length, f.path);
      try {
        const asset = await loadAsset(f);
        if (!asset.clips.length) { errors.push(`${f.path}: no animation found`); continue; }
        if (!collectBones(asset.scene).length) { errors.push(`${f.path}: no skeleton found`); continue; }
        clips += (await this.addClipsToLibrary(asset, f.source, f.path, true)).length;
      } catch (e) {
        errors.push(`${f.path}: ${(e as Error).message}`);
      }
      // Let the UI breathe during big packs.
      if (i % 5 === 4) await new Promise((r) => setTimeout(r, 0));
    }
    onProgress?.(files.length, files.length, '');
    return { clips, errors };
  }

  async playLibraryClip(ref: string, autoplay = true) {
    const meta = this.library.find(ref);
    if (!meta) throw new Error(`No animation matches "${ref}".`);
    if (!this.model) throw new Error('No model loaded.');
    const cacheKey = `${meta.id}|${this.inPlace}`;
    let clip = this.retargetCache.get(cacheKey);
    if (!clip) {
      const stored = await this.library.get(meta.id);
      if (!stored) throw new Error(`Animation "${meta.name}" is missing its data.`);
      clip = !this.inPlace && sameRig(stored.rig, this.model.rig)
        ? stored.clip
        : retargetClip(stored.clip, stored.rig, this.model.rig, { inPlace: this.inPlace });
      this.retargetCache.set(cacheKey, clip);
    }
    // Never lose the user's work: park an unsaved clip in "My clips" first.
    if (this.edit && !this.editSaved && this.edit.keys.length) await this.saveEditToLibrary();
    this.edit = null;
    void kv.set('edit', null);
    this.setClip(clip, meta.name, meta.id);
    if (autoplay) this.play();
    this.emit('edit');
    return meta;
  }

  async deleteClips(ids: string[]) {
    await this.library.remove(ids);
    this.emit('library');
  }

  // ---------------------------------------------------------------- playback

  setClip(clip: THREE.AnimationClip, label: string, id: string | null = null, keepTime = false) {
    if (!this.mixer) return;
    const t = keepTime ? this.time : 0;
    this.mixer.stopAllAction();
    if (this.clip && this.clip !== clip) this.mixer.uncacheClip(this.clip);
    this.clip = clip;
    this.clipLabel = label;
    this.clipId = id;
    this.action = this.mixer.clipAction(clip);
    this.action.setLoop(THREE.LoopRepeat, Infinity);
    this.action.play();
    this.setTime(Math.min(t, clip.duration));
    this.emit('clip');
  }

  stopClip() {
    this.mixer?.stopAllAction();
    this.clip = null;
    this.action = null;
    this.clipLabel = '';
    this.clipId = null;
    this.playing = false;
    this.emit('clip');
  }

  get duration() { return this.clip?.duration ?? 0; }
  get time() { return this.action ? this.action.time : 0; }

  setTime(t: number) {
    if (!this.mixer || !this.action) return;
    const d = this.duration;
    const clamped = d > 0 ? Math.max(0, Math.min(t, d - 1e-4)) : 0;
    this.action.paused = false;
    this.action.time = clamped;
    this.mixer.update(0);
    this.action.paused = !this.playing;
    this.dirty = false;
    this.emit('time');
    this.emit('pose');
  }

  play() {
    if (!this.action) return;
    this.playing = true;
    this.action.paused = false;
    this.emit('time');
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    if (this.action) this.action.paused = true;
    this.emit('time');
  }

  private frame(dt: number) {
    if (this.playing && this.mixer && this.action) {
      const before = this.action.time;
      this.mixer.update(dt * this.speed);
      if (!this.loop && this.action.time < before) { this.setTime(this.duration); this.pause(); }
      this.emit('time');
    }
    this.joints.update();
  }

  // ---------------------------------------------------------------- posing

  selectBone(bone: THREE.Bone | null) {
    this.joints.select(bone);
    const g = this.viewer.gizmo;
    if (bone) {
      g.attach(bone);
      g.setMode('rotate');
    } else g.detach();
    this.emit('select');
  }

  get selectedBone() { return this.joints.selectedBone; }

  boneLabel(b: THREE.Bone) { return this.model?.canonOf.get(b) ?? b.name; }

  resolveBone(ref: string): THREE.Bone {
    const m = this.model;
    if (!m) throw new Error('No model loaded.');
    const b = m.byCanon.get(ref) ?? m.byName.get(ref)
      ?? [...m.byCanon.entries()].find(([k]) => k.toLowerCase() === ref.toLowerCase())?.[1];
    if (!b) throw new Error(`Unknown joint "${ref}". Use list_joints to see valid names.`);
    return b;
  }

  /** Rotation of `bone` away from rest, in character axes, as if its parents were at rest. */
  getDelta(bone: THREE.Bone): THREE.Quaternion {
    const m = this.model!;
    const i = m.index.get(bone)!;
    return m.parentRestCharQ[i].clone().multiply(bone.quaternion).multiply(m.restCharQ[i].clone().invert());
  }

  setDelta(bone: THREE.Bone, delta: THREE.Quaternion) {
    const m = this.model!;
    const i = m.index.get(bone)!;
    bone.quaternion.copy(m.parentRestCharQ[i].clone().invert().multiply(delta).multiply(m.restCharQ[i])).normalize();
  }

  getHipsOffset(): THREE.Vector3 {
    const m = this.model!;
    const hips = m.byCanon.get('Hips');
    if (!hips || !m.restHipsChar) return new THREE.Vector3();
    m.container.updateMatrixWorld(true);
    return m.container.worldToLocal(hips.getWorldPosition(new THREE.Vector3())).sub(m.restHipsChar);
  }

  setHipsOffset(offset: THREE.Vector3) {
    const m = this.model!;
    const hips = m.byCanon.get('Hips');
    if (!hips || !m.restHipsChar) return;
    m.container.updateMatrixWorld(true);
    const world = m.container.localToWorld(m.restHipsChar.clone().add(offset));
    hips.position.copy(hips.parent!.worldToLocal(world));
  }

  getPose(joints?: string[]): PoseReport {
    const m = this.model;
    if (!m) throw new Error('No model loaded.');
    m.container.updateMatrixWorld(true);
    const out: PoseReport['joints'] = {};
    const list = joints?.length ? joints.map((j) => this.resolveBone(j)) : [...m.byCanon.values()];
    for (const b of list) {
      const e = new THREE.Euler().setFromQuaternion(this.getDelta(b), 'XYZ');
      out[this.boneLabel(b)] = {
        rotation_deg: [r1(e.x * DEG), r1(e.y * DEG), r1(e.z * DEG)],
        position_m: m.container.worldToLocal(b.getWorldPosition(new THREE.Vector3())).toArray().map(r3),
      };
    }
    return {
      time: r3(this.time),
      axes: 'X = character left, Y = up, Z = character forward; metres; rotations are degrees away from the rest T-pose, XYZ order',
      joints: out,
      hips_offset_m: this.getHipsOffset().toArray().map(r3),
    };
  }

  /**
   * Sets joint rotations. `mode: "absolute"` replaces the rotation away from
   * rest; `"relative"` adds to the current rotation.
   */
  setPose(joints: Record<string, { rotation_deg: number[] }>, mode: 'absolute' | 'relative' = 'absolute', hipsOffset?: number[]) {
    if (!this.model) throw new Error('No model loaded.');
    this.pause();
    for (const [name, pose] of Object.entries(joints)) {
      const bone = this.resolveBone(name);
      const [x, y, z] = pose.rotation_deg;
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(x * RAD, y * RAD, z * RAD, 'XYZ'));
      this.setDelta(bone, mode === 'relative' ? q.multiply(this.getDelta(bone)) : q);
    }
    if (hipsOffset) this.setHipsOffset(new THREE.Vector3().fromArray(hipsOffset));
    this.dirty = true;
    this.emit('pose');
  }

  resetPose(bones?: THREE.Bone[]) {
    const m = this.model;
    if (!m) return;
    this.pause();
    for (const b of bones ?? m.bones) {
      const rb = m.rig.bones[m.index.get(b)!];
      b.quaternion.fromArray(rb.q);
      if (!bones || m.canonOf.get(b) === 'Hips') b.position.fromArray(rb.p);
    }
    this.dirty = true;
    this.emit('pose');
  }

  /** Copies one side's pose onto the other (or swaps both) by reflecting across the YZ plane. */
  mirrorPose(mode: 'left-to-right' | 'right-to-left' | 'swap') {
    const m = this.model;
    if (!m) return;
    this.pause();
    const deltas = new Map<string, THREE.Quaternion>();
    for (const [c, b] of m.byCanon) deltas.set(c, this.getDelta(b));
    const reflect = (q: THREE.Quaternion) => new THREE.Quaternion(q.x, -q.y, -q.z, q.w);
    for (const [c, b] of m.byCanon) {
      const from = mirrorName(c);
      const src = deltas.get(from);
      if (!src) continue;
      const isLeft = c.startsWith('Left'), isRight = c.startsWith('Right');
      if (mode === 'left-to-right' && !isRight) continue;
      if (mode === 'right-to-left' && !isLeft) continue;
      if (mode === 'swap' || isLeft || isRight) this.setDelta(b, reflect(src));
    }
    this.dirty = true;
    this.emit('pose');
  }

  // ---------------------------------------------------------------- user clips (timeline)

  newEdit(name = 'My animation', duration = 2, fps = 30, fromCurrentPose = true) {
    this.edit = { name, duration, fps, keys: [] };
    if (fromCurrentPose && this.model) this.edit.keys.push(this.capturePoseKey(0));
    this.applyEdit(false);
  }

  /** Turns the playing library clip into editable keys, one every `step` frames. */
  editFromCurrentClip(step = 5) {
    if (!this.clip || !this.model) throw new Error('Play an animation first.');
    const fps = 30;
    const duration = this.clip.duration;
    const name = `${this.clipLabel} (edit)`;
    const keys: PoseKey[] = [];
    const frames = Math.round(duration * fps);
    for (let f = 0; f <= frames; f += step) {
      this.setTime(f / fps);
      keys.push(this.capturePoseKey(f / fps));
    }
    if (frames % step) { this.setTime(duration); keys.push(this.capturePoseKey(frames / fps)); }
    this.edit = { name, duration, fps, keys };
    this.applyEdit(false);
  }

  capturePoseKey(time: number): PoseKey {
    const m = this.model!;
    const q: Record<string, number[]> = {};
    for (const b of m.bones) q[b.name] = b.quaternion.toArray() as number[];
    const hips = m.byCanon.get('Hips');
    return { time, q, hips: hips ? hips.position.toArray() : undefined };
  }

  snap(t: number) { const fps = this.edit?.fps ?? 30; return Math.round(t * fps) / fps; }

  /** Stores the current pose as a key at `time` (default: playhead). */
  keyPose(time = this.time) {
    if (!this.edit) this.newEdit('My animation', Math.max(2, time), 30, false);
    const e = this.edit!;
    const t = this.snap(time);
    if (t > e.duration) e.duration = t;
    e.keys = e.keys.filter((k) => Math.abs(k.time - t) > 1e-4);
    e.keys.push(this.capturePoseKey(t));
    e.keys.sort((a, b) => a.time - b.time);
    this.dirty = false;
    this.applyEdit(true);
    return t;
  }

  deleteKey(time: number) {
    if (!this.edit) return;
    this.edit.keys = this.edit.keys.filter((k) => Math.abs(k.time - time) > 1e-4);
    this.applyEdit(true);
  }

  moveKey(from: number, to: number) {
    if (!this.edit) return;
    const k = this.edit.keys.find((x) => Math.abs(x.time - from) < 1e-4);
    if (!k) return;
    const t = Math.max(0, Math.min(this.snap(to), this.edit.duration));
    this.edit.keys = this.edit.keys.filter((x) => x === k || Math.abs(x.time - t) > 1e-4);
    k.time = t;
    this.edit.keys.sort((a, b) => a.time - b.time);
    this.applyEdit(true);
  }

  setEditProps(props: Partial<Pick<EditClip, 'name' | 'duration' | 'fps'>>) {
    if (!this.edit) return;
    Object.assign(this.edit, props);
    this.edit.keys = this.edit.keys.filter((k) => k.time <= this.edit!.duration + 1e-4);
    this.applyEdit(true);
  }

  buildEditClip(e: EditClip = this.edit!): THREE.AnimationClip {
    const m = this.model!;
    const keys = e.keys.length ? [...e.keys] : [this.capturePoseKey(0)];
    const times = keys.map((k) => k.time);
    // A single key holds the pose for the whole clip.
    if (keys.length === 1) { keys.push({ ...keys[0], time: e.duration }); times.push(e.duration); }
    const tracks: THREE.KeyframeTrack[] = [];
    for (const b of m.bones) {
      const values: number[] = [];
      let prev: THREE.Quaternion | null = null;
      for (const k of keys) {
        const q = new THREE.Quaternion().fromArray(k.q[b.name] ?? b.quaternion.toArray());
        // Keep neighbouring keys in the same hemisphere so slerp takes the short way.
        if (prev && prev.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
        values.push(q.x, q.y, q.z, q.w);
        prev = q;
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, values));
    }
    const hips = m.byCanon.get('Hips');
    if (hips && keys.every((k) => k.hips)) {
      tracks.push(new THREE.VectorKeyframeTrack(`${hips.name}.position`, times, keys.flatMap((k) => k.hips!)));
    }
    return new THREE.AnimationClip(e.name, e.duration, tracks);
  }

  applyEdit(keepTime = true) {
    if (!this.edit || !this.model) { this.emit('edit'); return; }
    this.setClip(this.buildEditClip(), this.edit.name, null, keepTime);
    this.editSaved = false;
    void kv.set('edit', this.edit);
    this.emit('edit');
  }

  closeEdit() {
    this.edit = null;
    void kv.set('edit', null);
    this.stopClip();
    this.emit('edit');
  }

  async saveEditToLibrary() {
    if (!this.edit || !this.model) throw new Error('Nothing to save.');
    const clip = this.buildEditClip();
    const meta = await this.library.add(clip, this.model.rig, 'My clips', this.model.name);
    this.editSaved = true;
    this.retargetCache.clear();
    this.emit('library');
    return meta;
  }

  /** Creates a clip from AI-supplied keys given as rotations away from rest. */
  createClipFromPoses(name: string, fps: number, keys: { time: number; joints: Record<string, { rotation_deg: number[] }>; hips_offset_m?: number[] }[], duration?: number) {
    if (!this.model) throw new Error('No model loaded.');
    if (!keys.length) throw new Error('Give at least one key.');
    const sorted = [...keys].sort((a, b) => a.time - b.time);
    this.edit = { name, fps, duration: duration ?? Math.max(sorted[sorted.length - 1].time, 1 / fps), keys: [] };
    for (const k of sorted) {
      this.resetPose();
      this.setPose(k.joints, 'absolute', k.hips_offset_m);
      this.edit.keys.push(this.capturePoseKey(this.snap(k.time)));
    }
    this.applyEdit(false);
  }

  // ---------------------------------------------------------------- analysis & export

  /** Samples a clip into AI-readable frames without disturbing the editor state. */
  sampleFrames(fps = 10, joints?: string[]) {
    if (!this.clip) throw new Error('No animation is active.');
    const keep = this.time, wasPlaying = this.playing;
    this.pause();
    const frames: PoseReport[] = [];
    const n = Math.max(1, Math.round(this.duration * fps));
    for (let i = 0; i <= n; i++) {
      this.setTime((i / n) * this.duration);
      frames.push(this.getPose(joints));
    }
    this.setTime(keep);
    if (wasPlaying) this.play();
    return frames;
  }

  describeClip(fps = 10, joints?: string[]) {
    return {
      format: 'animation-editor/clip@1',
      name: this.clipLabel,
      duration_s: r3(this.duration),
      skeleton: 'Mixamo bone names (without the mixamorig prefix)',
      notes: this.notes,
      keys: this.edit ? this.edit.keys.map((k) => r3(k.time)) : undefined,
      frames: this.sampleFrames(fps, joints),
    };
  }

  /** Grid of evenly spaced frames from one or more views, labelled with time. */
  contactSheet(frames = 8, views: ViewName[] = ['front', 'right'], tile = 256): HTMLCanvasElement {
    const cols = Math.min(frames, 8);
    const rowsPerView = Math.ceil(frames / cols);
    const label = 22;
    const canvas = document.createElement('canvas');
    canvas.width = cols * tile;
    canvas.height = views.length * rowsPerView * (tile + label);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#1b1c20';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const keep = this.time, wasPlaying = this.playing;
    this.pause();
    this.joints.visible = false;
    views.forEach((view, vi) => {
      for (let i = 0; i < frames; i++) {
        const t = this.clip ? (frames === 1 ? keep : (i / (frames - 1)) * this.duration) : keep;
        if (this.clip) this.setTime(t);
        const shot = this.viewer.snapshot(view, tile, tile);
        const x = (i % cols) * tile;
        const y = (vi * rowsPerView + Math.floor(i / cols)) * (tile + label);
        ctx.drawImage(shot, x, y + label);
        ctx.fillStyle = '#e0e0e0';
        ctx.font = '13px system-ui, sans-serif';
        ctx.fillText(`${view}  ${t.toFixed(2)}s`, x + 6, y + 15);
      }
    });
    this.joints.visible = true;
    if (this.clip) this.setTime(keep);
    if (wasPlaying) this.play();
    return canvas;
  }

  /** Records one loop of the active clip from `view` as a WebM video. */
  async recordVideo(view: ViewName = 'three_quarter', size = 640): Promise<Blob> {
    if (!this.clip) throw new Error('No animation is active.');
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm' });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise<Blob>((resolve) => { recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' })); });
    const keep = this.time, wasPlaying = this.playing;
    this.pause();
    this.joints.visible = false;
    recorder.start();
    const start = performance.now();
    const duration = this.duration;
    await new Promise<void>((resolve) => {
      const step = () => {
        const t = (performance.now() - start) / 1000;
        this.setTime(Math.min(t, duration));
        ctx.drawImage(this.viewer.snapshot(view, size, size), 0, 0);
        if (t >= duration) resolve(); else requestAnimationFrame(step);
      };
      step();
    });
    recorder.stop();
    this.joints.visible = true;
    this.setTime(keep);
    if (wasPlaying) this.play();
    return done;
  }

  /** Exports the model (in rest pose) with the chosen clips as a binary glTF. */
  async exportGLB(clips: THREE.AnimationClip[]): Promise<ArrayBuffer> {
    const m = this.model;
    if (!m) throw new Error('No model loaded.');
    const keep = this.time, wasPlaying = this.playing, active = this.clip;
    this.mixer?.stopAllAction();
    this.resetPose();
    const savedPos = m.root.position.clone();
    m.root.position.set(0, 0, 0);
    try {
      const result = await new GLTFExporter().parseAsync(m.root, { binary: true, animations: clips, onlyVisible: true });
      return result as ArrayBuffer;
    } finally {
      m.root.position.copy(savedPos);
      if (active) { this.setClip(active, this.clipLabel, this.clipId); this.setTime(keep); if (wasPlaying) this.play(); }
    }
  }

  async setNotes(text: string) {
    this.notes = text;
    await kv.set('notes', text);
    this.emit('notes');
  }

  /** Bone mapping summary for the UI and the AI. */
  jointList() {
    const m = this.model;
    if (!m) return [];
    return m.rig.bones.map((b) => ({ name: b.name, canonical: b.canonical }));
  }

  remap(names: string[]) { return mapBones(names, this.customBoneMap); }
}
