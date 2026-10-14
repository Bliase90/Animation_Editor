import * as THREE from 'three';

/**
 * A simple built-in character with a Mixamo-named skeleton, so the editor is
 * usable (and the AI can pose something) before any model is imported.
 * Faces +Z, left hand toward +X, about 1.8 m tall, T-pose.
 */
export function createMannequin(): THREE.Group {
  const root = new THREE.Group();
  root.name = 'Mannequin';
  const mat = new THREE.MeshStandardMaterial({ color: 0xb8bcc6, roughness: 0.6, metalness: 0.05 });
  const jointMat = new THREE.MeshStandardMaterial({ color: 0x8a90a0, roughness: 0.5 });

  const bones = new Map<string, THREE.Bone>();
  const bone = (name: string, parent: string | null, x: number, y: number, z: number) => {
    const b = new THREE.Bone();
    b.name = `mixamorig${name}`;
    b.position.set(x, y, z);
    (parent ? bones.get(parent)! : root).add(b);
    bones.set(name, b);
    return b;
  };

  bone('Hips', null, 0, 1.0, 0);
  bone('Spine', 'Hips', 0, 0.1, 0);
  bone('Spine1', 'Spine', 0, 0.12, 0);
  bone('Spine2', 'Spine1', 0, 0.12, 0);
  bone('Neck', 'Spine2', 0, 0.16, 0);
  bone('Head', 'Neck', 0, 0.09, 0.01);
  bone('HeadTop_End', 'Head', 0, 0.21, 0);
  for (const [S, s] of [['Left', 1], ['Right', -1]] as const) {
    bone(`${S}Shoulder`, 'Spine2', 0.05 * s, 0.11, 0);
    bone(`${S}Arm`, `${S}Shoulder`, 0.12 * s, 0, 0);
    bone(`${S}ForeArm`, `${S}Arm`, 0.27 * s, 0, 0);
    bone(`${S}Hand`, `${S}ForeArm`, 0.25 * s, 0, 0);
    bone(`${S}HandMiddle1`, `${S}Hand`, 0.09 * s, 0, 0);
    bone(`${S}HandThumb1`, `${S}Hand`, 0.03 * s, -0.01, 0.04);
    bone(`${S}UpLeg`, 'Hips', 0.09 * s, -0.06, 0);
    bone(`${S}Leg`, `${S}UpLeg`, 0, -0.44, 0);
    bone(`${S}Foot`, `${S}Leg`, 0, -0.42, 0);
    bone(`${S}ToeBase`, `${S}Foot`, 0, -0.07, 0.11);
    bone(`${S}Toe_End`, `${S}ToeBase`, 0, 0, 0.07);
  }

  // A capsule from each bone toward each child, attached rigidly to the bone.
  const up = new THREE.Vector3(0, 1, 0);
  for (const [name, b] of bones) {
    const radius = /Spine|Hips/.test(name) ? 0.09 : /Neck/.test(name) ? 0.045 : /UpLeg/.test(name) ? 0.065
      : /Leg/.test(name) ? 0.05 : /ForeArm/.test(name) ? 0.038 : /Arm$/.test(name) ? 0.045 : 0.03;
    for (const child of b.children) {
      if (!(child as THREE.Bone).isBone) continue;
      // Covered by the head, hand, foot, chest and pelvis shapes below.
      if (/Head|Hand|Foot|Toe/.test(name) || (/Spine2/.test(name) && /Shoulder/.test(child.name)) || (name === 'Hips' && /UpLeg/.test(child.name))) continue;
      const v = child.position.clone();
      const len = v.length();
      const geo = new THREE.CapsuleGeometry(radius, Math.max(0.001, len - radius * 1.2), 4, 10);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(v).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(up, v.clone().normalize());
      mesh.name = `${name}_shape`;
      b.add(mesh);
    }
  }
  // Head, chest and hands.
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 20, 14), mat);
  head.scale.set(0.9, 1.15, 1);
  head.position.set(0, 0.1, 0.01);
  bones.get('Head')!.add(head);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.06, 10), jointMat);
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 0.09, 0.115);
  bones.get('Head')!.add(nose);
  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.22, 0.2), mat);
  chest.position.set(0, 0.08, 0);
  bones.get('Spine2')!.add(chest);
  const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.16, 0.18), mat);
  bones.get('Hips')!.add(pelvis);
  for (const s of ['Left', 'Right']) {
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.03, 0.08), jointMat);
    hand.position.set(s === 'Left' ? 0.05 : -0.05, 0, 0);
    bones.get(`${s}Hand`)!.add(hand);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.06, 0.2), jointMat);
    foot.position.set(0, -0.05, 0.06);
    bones.get(`${s}Foot`)!.add(foot);
  }
  return root;
}
