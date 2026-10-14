import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { BVHLoader } from 'three/addons/loaders/BVHLoader.js';

export const MODEL_EXTENSIONS = ['fbx', 'glb', 'gltf'];
export const ANIMATION_EXTENSIONS = ['fbx', 'glb', 'gltf', 'bvh'];

export interface LoadedAsset {
  fileName: string;
  scene: THREE.Object3D;
  clips: THREE.AnimationClip[];
  hasMesh: boolean;
}

export const extOf = (name: string) => name.split('.').pop()!.toLowerCase();
export const baseName = (name: string) => name.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');

/** A file to load plus any sibling files it may reference (glTF buffers, textures). */
export interface FileInput {
  name: string;
  data: ArrayBuffer;
  siblings?: Map<string, Blob>;
}

function managerFor(siblings?: Map<string, Blob>): { manager: THREE.LoadingManager; dispose: () => void } {
  const manager = new THREE.LoadingManager();
  const urls: string[] = [];
  if (siblings?.size) {
    const byName = new Map<string, string>();
    for (const [name, blob] of siblings) {
      const url = URL.createObjectURL(blob);
      urls.push(url);
      byName.set(name.replace(/^.*[\\/]/, '').toLowerCase(), url);
    }
    manager.setURLModifier((url) => {
      const file = decodeURIComponent(url.replace(/[?#].*$/, '').replace(/^.*[\\/]/, '')).toLowerCase();
      return byName.get(file) ?? url;
    });
  }
  return { manager, dispose: () => urls.forEach((u) => URL.revokeObjectURL(u)) };
}

export async function loadAsset(input: FileInput): Promise<LoadedAsset> {
  const ext = extOf(input.name);
  const { manager, dispose } = managerFor(input.siblings);
  try {
    let scene: THREE.Object3D;
    let clips: THREE.AnimationClip[] = [];
    if (ext === 'fbx') {
      scene = new FBXLoader(manager).parse(input.data, '');
      clips = (scene as THREE.Object3D & { animations: THREE.AnimationClip[] }).animations ?? [];
    } else if (ext === 'glb' || ext === 'gltf') {
      const gltf = await new GLTFLoader(manager).parseAsync(input.data, '');
      scene = gltf.scene;
      clips = gltf.animations;
    } else if (ext === 'bvh') {
      const bvh = new BVHLoader(manager).parse(new TextDecoder().decode(input.data));
      scene = new THREE.Group();
      scene.add(bvh.skeleton.bones[0]);
      clips = [bvh.clip];
    } else {
      throw new Error(`Unsupported file type .${ext}. Convert it to FBX, glTF/GLB or BVH first (see docs/IMPORTING.md).`);
    }
    let hasMesh = false;
    scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) hasMesh = true; });
    const base = baseName(input.name);
    clips = clips.filter((c) => c.duration > 0 && c.tracks.length > 0);
    clips.forEach((c, i) => {
      // Mixamo exports every clip as "mixamo.com"; use the file name instead.
      if (!c.name || /^mixamo\.com$/i.test(c.name) || /^take\s*0*1$/i.test(c.name) || /^armature\|/i.test(c.name)) {
        c.name = clips.length > 1 ? `${base} ${i + 1}` : base;
      }
    });
    return { fileName: input.name, scene, clips, hasMesh };
  } finally {
    // Textures may still be decoding from blob URLs; release them a little later.
    setTimeout(dispose, 10000);
  }
}
