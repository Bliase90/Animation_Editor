import { describe, it, expect } from 'vitest';
import { mapBones, stripPrefix, detectRigKind, coverage } from '../src/rig';

describe('bone naming', () => {
  it('strips mixamo prefixes from FBX and glTF names', () => {
    expect(stripPrefix('mixamorig:LeftArm')).toBe('LeftArm');
    expect(stripPrefix('mixamorigLeftArm')).toBe('LeftArm');
    expect(stripPrefix('mixamorig1:Hips')).toBe('Hips');
    expect(stripPrefix('Armature|mixamorig:Spine1')).toBe('Spine1');
  });

  it('maps a Mixamo rig fully', () => {
    const names = ['mixamorigHips', 'mixamorigSpine', 'mixamorigLeftUpLeg', 'mixamorigRightHandIndex2'];
    const m = mapBones(names);
    expect(detectRigKind(names)).toBe('mixamo');
    expect(m.mixamorigHips).toBe('Hips');
    expect(m.mixamorigRightHandIndex2).toBe('RightHandIndex2');
  });

  it('maps Unreal mannequin names', () => {
    const names = ['root', 'pelvis', 'spine_01', 'spine_02', 'spine_03', 'clavicle_l', 'upperarm_l', 'lowerarm_l', 'hand_l', 'thigh_r', 'calf_r', 'foot_r', 'ball_r', 'index_02_l'];
    const m = mapBones(names);
    expect(detectRigKind(names)).toBe('unreal4');
    expect(m.pelvis).toBe('Hips');
    expect(m.spine_03).toBe('Spine2');
    expect(m.upperarm_l).toBe('LeftArm');
    expect(m.calf_r).toBe('RightLeg');
    expect(m.index_02_l).toBe('LeftHandIndex2');
    expect(m.root).toBeNull();
  });

  it('maps 3ds Max Biped names', () => {
    const names = ['Bip01', 'Bip01 Pelvis', 'Bip01 Spine', 'Bip01 L Thigh', 'Bip01 R UpperArm', 'Bip01 L Finger1'];
    const m = mapBones(names);
    expect(m['Bip01 Pelvis']).toBe('Hips');
    expect(m['Bip01 L Thigh']).toBe('LeftUpLeg');
    expect(m['Bip01 R UpperArm']).toBe('RightArm');
    expect(m['Bip01 L Finger1']).toBe('LeftHandIndex1');
  });

  it('guesses unfamiliar rigs and honours custom maps', () => {
    const names = ['Root', 'Pelvis_jnt', 'Chest', 'L_UpperArm', 'R_Thigh', 'weird_bone'];
    const m = mapBones(names, { weird_bone: 'Head' });
    expect(m.Pelvis_jnt).toBe('Hips');
    expect(m.L_UpperArm).toBe('LeftArm');
    expect(m.R_Thigh).toBe('RightUpLeg');
    expect(m.weird_bone).toBe('Head');
    expect(coverage(m)).toBeGreaterThan(0);
  });
});
