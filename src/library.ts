import * as THREE from 'three';
import type { RigInfo } from './retarget';

/** Metadata shown in the animation library list. */
export interface ClipMeta {
  id: string;
  name: string;
  /** Pack or folder the clip came from, e.g. "Mixamo", "Xplode Combat", "My clips". */
  source: string;
  file: string;
  duration: number;
  boneCount: number;
  rigKind: string;
  createdAt: number;
}

interface StoredTrack { name: string; type: string; times: Float32Array; values: Float32Array }
interface ClipData { id: string; tracks: StoredTrack[]; rig: RigInfo }

const DB_NAME = 'animation-editor';
const DB_VERSION = 1;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const d = open.result;
      d.createObjectStore('meta', { keyPath: 'id' });
      d.createObjectStore('data', { keyPath: 'id' });
      d.createObjectStore('kv');
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  return dbPromise;
}

async function store(name: string, mode: IDBTransactionMode = 'readonly') {
  return (await db()).transaction(name, mode).objectStore(name);
}

export function clipId(source: string, file: string, name: string) {
  return `${source}::${file}::${name}`;
}

function trackType(t: THREE.KeyframeTrack): string {
  return (t.constructor as unknown as { prototype: { ValueTypeName: string } }).prototype.ValueTypeName ?? 'number';
}

export function serializeTracks(clip: THREE.AnimationClip): StoredTrack[] {
  return clip.tracks.map((t) => ({
    name: t.name,
    type: trackType(t),
    times: new Float32Array(t.times),
    values: new Float32Array(t.values),
  }));
}

export function deserializeClip(name: string, duration: number, tracks: StoredTrack[]): THREE.AnimationClip {
  const ctor: Record<string, new (n: string, t: ArrayLike<number>, v: ArrayLike<number>) => THREE.KeyframeTrack> = {
    quaternion: THREE.QuaternionKeyframeTrack,
    vector: THREE.VectorKeyframeTrack,
    number: THREE.NumberKeyframeTrack,
  };
  return new THREE.AnimationClip(name, duration, tracks.map((t) => new (ctor[t.type] ?? THREE.NumberKeyframeTrack)(t.name, t.times, t.values)));
}

export class Library {
  items: ClipMeta[] = [];

  async load() {
    this.items = await req((await store('meta')).getAll() as IDBRequest<ClipMeta[]>);
    this.items.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
  }

  has(id: string) { return this.items.some((m) => m.id === id); }

  async add(clip: THREE.AnimationClip, rig: RigInfo, source: string, file: string): Promise<ClipMeta> {
    const id = clipId(source, file, clip.name);
    const meta: ClipMeta = {
      id, name: clip.name, source, file, duration: clip.duration,
      boneCount: rig.bones.length, rigKind: rig.kind, createdAt: Date.now(),
    };
    const d = await db();
    const tx = d.transaction(['meta', 'data'], 'readwrite');
    tx.objectStore('meta').put(meta);
    tx.objectStore('data').put({ id, tracks: serializeTracks(clip), rig } satisfies ClipData);
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    this.items = this.items.filter((m) => m.id !== id);
    this.items.push(meta);
    return meta;
  }

  async get(id: string): Promise<{ meta: ClipMeta; clip: THREE.AnimationClip; rig: RigInfo } | null> {
    const meta = this.items.find((m) => m.id === id);
    if (!meta) return null;
    const data = await req((await store('data')).get(id) as IDBRequest<ClipData | undefined>);
    if (!data) return null;
    return { meta, clip: deserializeClip(meta.name, meta.duration, data.tracks), rig: data.rig };
  }

  async remove(ids: string[]) {
    const d = await db();
    const tx = d.transaction(['meta', 'data'], 'readwrite');
    for (const id of ids) { tx.objectStore('meta').delete(id); tx.objectStore('data').delete(id); }
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    const set = new Set(ids);
    this.items = this.items.filter((m) => !set.has(m.id));
  }

  sources(): string[] {
    return [...new Set(this.items.map((m) => m.source))].sort();
  }

  /** Finds a clip by id, exact name, or case-insensitive name substring. */
  find(ref: string): ClipMeta | undefined {
    const lower = ref.toLowerCase();
    return this.items.find((m) => m.id === ref)
      ?? this.items.find((m) => m.name === ref)
      ?? this.items.find((m) => m.name.toLowerCase() === lower)
      ?? this.items.find((m) => m.name.toLowerCase().includes(lower));
  }

  search(query = '', source = ''): ClipMeta[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.items.filter((m) => (!source || m.source === source)
      && terms.every((t) => m.name.toLowerCase().includes(t) || m.source.toLowerCase().includes(t) || m.file.toLowerCase().includes(t)));
  }
}

/** Small key-value store for settings, notes and the last opened model. */
export const kv = {
  async get<T>(key: string): Promise<T | undefined> {
    return req((await store('kv')).get(key) as IDBRequest<T | undefined>);
  },
  async set(key: string, value: unknown) {
    await req((await store('kv', 'readwrite')).put(value, key));
  },
};
