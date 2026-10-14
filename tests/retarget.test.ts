import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { extractRig, retargetClip, buildSkeleton } from '../src/retarget';

// Builds a three-bone chain Hips > Spine > LeftArm with optional rest twists.
function makeRig(prefix: string, twist: number, scale = 1) {
  const root = new THREE.Group();
  const hips = new THREE.Bone(); hips.name = `${prefix}Hips`; hips.position.set(0, 1 * scale, 0);
  const spine = new THREE.Bone(); spine.name = `${prefix}Spine`; spine.position.set(0, 0.2 * scale, 0);
  const arm = new THREE.Bone(); arm.name = `${prefix}LeftArm`; arm.position.set(0.2 * scale, 0.3 * scale, 0);
  // Different local axes per rig: twist each bone's rest rotation.
  spine.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), twist);
  arm.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), twist);
  hips.add(spine); spine.add(arm); root.add(hips);
  return root;
}

function worldQ(bones: THREE.Bone[], name: string) {
  const b = bones.find((x) => x.name.endsWith(name))!;
  return b.getWorldQuaternion(new THREE.Quaternion());
}

describe('retargetClip', () => {
  it('reproduces world-space motion on a rig with different bone axes and size', () => {
    const src = extractRig(makeRig('mixamorig', 0));
    const tgt = extractRig(makeRig('', 0.7, 2));
    // Source clip: spine bends 40 degrees about Z at t=1, hips rise 0.1.
    const bend = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(40));
    const clip = new THREE.AnimationClip('bend', 1, [
      new THREE.QuaternionKeyframeTrack('mixamorigSpine.quaternion', [0, 1], [0, 0, 0, 1, ...bend.toArray()]),
      new THREE.VectorKeyframeTrack('mixamorigHips.position', [0, 1], [0, 1, 0, 0, 1.1, 0]),
    ]);
    const out = retargetClip(clip, src, tgt, { fps: 10 });

    const s = buildSkeleton(src), t = buildSkeleton(tgt);
    const pose = (root: THREE.Object3D, c: THREE.AnimationClip) => {
      const m = new THREE.AnimationMixer(root);
      const a = m.clipAction(c); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.play();
      m.setTime(1); root.updateMatrixWorld(true);
    };
    pose(s.root, clip); pose(t.root, out);

    // World rotation change from rest must match for each mapped bone.
    for (const name of ['Spine', 'LeftArm']) {
      const srcRest = buildSkeleton(src).bones, tgtRest = buildSkeleton(tgt).bones;
      const dS = worldQ(s.bones, name).multiply(worldQ(srcRest, name).invert());
      const dT = worldQ(t.bones, name).multiply(worldQ(tgtRest, name).invert());
      expect(Math.abs(dS.dot(dT))).toBeGreaterThan(0.9999);
    }
    // Hips rise is scaled by the 2x size difference.
    const hips = t.bones.find((b) => b.name === 'Hips')!;
    expect(hips.position.y).toBeCloseTo(2.2, 3);
  });
});
