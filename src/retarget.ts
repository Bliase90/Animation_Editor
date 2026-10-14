import * as THREE from 'three';
import { mapBones, detectRigKind, type RigKind } from './rig';

/** Serializable description of a skeleton in its rest pose. */
export interface RigBone {
  name: string;
  canonical: string | null;
  parent: number; // index into bones, -1 for roots
  p: number[];
  q: number[];
  s: number[];
  /** For root bones: matrix of the non-bone ancestors, relative to the file's scene root. */
  pm?: number[];
}

export interface RigInfo {
  kind: RigKind;
  bones: RigBone[];
}

const isBone = (o: THREE.Object3D | null): o is THREE.Bone => !!o && (o as THREE.Bone).isBone;

/**
 * All bones under `root`, parents before children. FBXLoader nests a copy of
 * a bone under itself when several meshes share it; those copies are skipped.
 */
export function collectBones(root: THREE.Object3D): THREE.Bone[] {
  const bones: THREE.Bone[] = [];
  root.traverse((o) => {
    if (isBone(o) && !(isBone(o.parent) && o.parent.name === o.name)) bones.push(o);
  });
  return bones;
}

/** Matrix of `obj` expressed in the frame of `ancestor`. */
function relativeMatrix(obj: THREE.Object3D, ancestor: THREE.Object3D): THREE.Matrix4 {
  ancestor.updateWorldMatrix(true, true);
  return new THREE.Matrix4().copy(ancestor.matrixWorld).invert().multiply(obj.matrixWorld);
}

/** Captures the current (rest) transforms of every bone under `root`. */
export function extractRig(root: THREE.Object3D, custom: Record<string, string> = {}): RigInfo {
  const bones = collectBones(root);
  const names = bones.map((b) => b.name);
  const mapping = mapBones(names, custom);
  const index = new Map(bones.map((b, i) => [b, i]));
  root.updateWorldMatrix(true, true);
  return {
    kind: detectRigKind(names),
    bones: bones.map((b) => {
      let up = b.parent;
      while (isBone(up) && !index.has(up)) up = up.parent;
      const parent = isBone(up) ? index.get(up)! : -1;
      const rb: RigBone = {
        name: b.name,
        canonical: mapping[b.name],
        parent,
        p: b.position.toArray(),
        q: b.quaternion.toArray() as number[],
        s: b.scale.toArray(),
      };
      if (parent < 0 && up) rb.pm = relativeMatrix(up, root).toArray();
      return rb;
    }),
  };
}

/** Builds a standalone bone hierarchy from rig info (for sampling source clips). */
export function buildSkeleton(rig: RigInfo): { root: THREE.Group; bones: THREE.Bone[] } {
  const root = new THREE.Group();
  const bones = rig.bones.map((rb) => {
    const b = new THREE.Bone();
    b.name = rb.name;
    b.position.fromArray(rb.p);
    b.quaternion.fromArray(rb.q);
    b.scale.fromArray(rb.s);
    return b;
  });
  rig.bones.forEach((rb, i) => {
    if (rb.parent >= 0) bones[rb.parent].add(bones[i]);
    else {
      const holder = new THREE.Object3D();
      if (rb.pm) { holder.matrix.fromArray(rb.pm); holder.matrixAutoUpdate = false; }
      holder.add(bones[i]);
      root.add(holder);
    }
  });
  root.updateMatrixWorld(true);
  return { root, bones };
}

/** Rest-pose matrices of each rig bone in the rig's own scene frame. */
function restMatrices(rig: RigInfo): THREE.Matrix4[] {
  const out: THREE.Matrix4[] = [];
  const local = new THREE.Matrix4();
  rig.bones.forEach((rb, i) => {
    local.compose(new THREE.Vector3().fromArray(rb.p), new THREE.Quaternion().fromArray(rb.q), new THREE.Vector3().fromArray(rb.s));
    const parent = rb.parent >= 0 ? out[rb.parent] : rb.pm ? new THREE.Matrix4().fromArray(rb.pm) : new THREE.Matrix4();
    out[i] = new THREE.Matrix4().multiplyMatrices(parent, local);
  });
  return out;
}

const rotOf = (m: THREE.Matrix4) => {
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  m.decompose(p, q, s);
  return q;
};
const posOf = (m: THREE.Matrix4) => new THREE.Vector3().setFromMatrixPosition(m);

export interface RetargetOptions {
  fps?: number;
  /** Removes horizontal hips travel so the character animates on the spot. */
  inPlace?: boolean;
}

/**
 * Retargets `clip` (authored for `source`) onto `target`.
 *
 * Each mapped bone's rotation change from its rest pose is measured in the
 * source's character space and re-applied on top of the target's rest pose,
 * so rigs with different bone orientations still line up. Hips travel is
 * scaled by the ratio of hips heights. Both rigs are expected to be Y-up and
 * facing +Z (Mixamo convention) with similar rest poses (T-pose to T-pose).
 */
export function retargetClip(clip: THREE.AnimationClip, source: RigInfo, target: RigInfo, opts: RetargetOptions = {}): THREE.AnimationClip {
  const fps = opts.fps ?? 30;
  const { root: srcRoot, bones: srcBones } = buildSkeleton(source);
  const srcRest = restMatrices(source);
  const tgtRest = restMatrices(target);

  const srcByCanon = new Map<string, number>();
  source.bones.forEach((b, i) => { if (b.canonical) srcByCanon.set(b.canonical, i); });

  // Only keep tracks that bind to source bones; avoids binding warnings.
  const srcNames = new Set(source.bones.map((b) => b.name));
  const tracks = clip.tracks.filter((t) => srcNames.has(THREE.PropertyBinding.parseTrackName(t.name).nodeName));
  const srcClip = new THREE.AnimationClip(clip.name, clip.duration, tracks);
  const mixer = new THREE.AnimationMixer(srcRoot);
  const action = mixer.clipAction(srcClip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();

  const srcRestQ = srcRest.map(rotOf);
  const tgtRestQ = tgtRest.map(rotOf);
  const tgtParentQ = target.bones.map((b) => (b.parent < 0 ? (b.pm ? rotOf(new THREE.Matrix4().fromArray(b.pm)) : new THREE.Quaternion()) : null));

  const tgtHips = target.bones.findIndex((b) => b.canonical === 'Hips');
  const srcHips = srcByCanon.get('Hips');
  let scale = 1;
  if (tgtHips >= 0 && srcHips !== undefined) {
    const sy = posOf(srcRest[srcHips]).y, ty = posOf(tgtRest[tgtHips]).y;
    if (Math.abs(sy) > 1e-6 && Math.abs(ty) > 1e-6) scale = ty / sy;
  }
  const tgtHipsParentInv = tgtHips >= 0
    ? (target.bones[tgtHips].parent >= 0 ? tgtRest[target.bones[tgtHips].parent].clone() : new THREE.Matrix4().fromArray(target.bones[tgtHips].pm ?? new THREE.Matrix4().toArray())).invert()
    : null;

  const frames = Math.max(2, Math.round(clip.duration * fps) + 1);
  const times = new Float32Array(frames);
  const qValues = target.bones.map(() => new Float32Array(frames * 4));
  const hipsValues = new Float32Array(frames * 3);

  const srcQ: THREE.Quaternion[] = srcBones.map(() => new THREE.Quaternion());
  const charQ: THREE.Quaternion[] = target.bones.map(() => new THREE.Quaternion());
  const delta = new THREE.Quaternion();
  const local = new THREE.Quaternion();
  const restLocal = target.bones.map((b) => new THREE.Quaternion().fromArray(b.q));

  for (let f = 0; f < frames; f++) {
    const t = Math.min(clip.duration, f / fps);
    times[f] = t;
    mixer.setTime(t);
    srcRoot.updateMatrixWorld(true);
    srcBones.forEach((b, i) => srcQ[i].copy(rotOf(b.matrixWorld)));

    target.bones.forEach((tb, i) => {
      const parentQ = tb.parent >= 0 ? charQ[tb.parent] : tgtParentQ[i]!;
      const si = tb.canonical ? srcByCanon.get(tb.canonical) : undefined;
      if (si !== undefined) {
        delta.copy(srcQ[si]).multiply(srcRestQ[si].clone().invert());
        charQ[i].copy(delta).multiply(tgtRestQ[i]);
        local.copy(parentQ).invert().multiply(charQ[i]);
      } else {
        local.copy(restLocal[i]);
        charQ[i].copy(parentQ).multiply(local);
      }
      local.normalize().toArray(qValues[i], f * 4);
    });

    if (tgtHips >= 0 && srcHips !== undefined && tgtHipsParentInv) {
      const d = posOf(srcBones[srcHips].matrixWorld).sub(posOf(srcRest[srcHips])).multiplyScalar(scale);
      if (opts.inPlace) { d.x = 0; d.z = 0; }
      const p = posOf(tgtRest[tgtHips]).add(d).applyMatrix4(tgtHipsParentInv);
      p.toArray(hipsValues, f * 3);
    }
  }
  mixer.stopAllAction();

  const out: THREE.KeyframeTrack[] = [];
  target.bones.forEach((tb, i) => {
    out.push(new THREE.QuaternionKeyframeTrack(`${tb.name}.quaternion`, times, qValues[i]));
  });
  if (tgtHips >= 0 && srcHips !== undefined) {
    out.push(new THREE.VectorKeyframeTrack(`${target.bones[tgtHips].name}.position`, times, hipsValues));
  }
  return new THREE.AnimationClip(clip.name, clip.duration, out);
}

/** True when two rigs share bone names and rest rotations, so clips can play unchanged. */
export function sameRig(a: RigInfo, b: RigInfo): boolean {
  if (a.bones.length !== b.bones.length) return false;
  return a.bones.every((ab, i) => {
    const bb = b.bones[i];
    if (ab.name !== bb.name) return false;
    const qa = new THREE.Quaternion().fromArray(ab.q), qb = new THREE.Quaternion().fromArray(bb.q);
    return Math.abs(qa.dot(qb)) > 0.9999;
  });
}
