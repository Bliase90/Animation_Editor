// Canonical skeleton = Mixamo bone names without the "mixamorig:" prefix.
// Every imported rig is mapped onto these names so clips from different
// sources (Mixamo, Unreal-style packs, 3ds Max Biped, game exports) can be
// played on the same character.

const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'] as const;

function sideBones(side: 'Left' | 'Right'): string[] {
  const bones = [
    `${side}Shoulder`, `${side}Arm`, `${side}ForeArm`, `${side}Hand`,
    `${side}UpLeg`, `${side}Leg`, `${side}Foot`, `${side}ToeBase`, `${side}Toe_End`, `${side}Eye`,
  ];
  for (const f of FINGERS) for (let i = 1; i <= 4; i++) bones.push(`${side}Hand${f}${i}`);
  return bones;
}

export const MIXAMO_BONES: string[] = [
  'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'HeadTop_End',
  ...sideBones('Left'), ...sideBones('Right'),
];

const MIXAMO_LOOKUP = new Map(MIXAMO_BONES.map((b) => [b.toLowerCase(), b]));

/** Bones that matter most when posing; used to keep the joint list readable. */
export const CORE_BONES = new Set([
  'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
  'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
  'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase',
  'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase',
]);

/** Strips Mixamo/FBX/glTF namespace noise from a bone name. */
export function stripPrefix(name: string): string {
  let n = name;
  const pipe = n.lastIndexOf('|');
  if (pipe >= 0) n = n.slice(pipe + 1);
  n = n.replace(/^mixamorig\d*[:_]?/i, '');
  const colon = n.lastIndexOf(':');
  if (colon >= 0) n = n.slice(colon + 1);
  return n;
}

const key = (s: string) => s.toLowerCase().replace(/[\s_.\-:]/g, '');

type Preset = Record<string, string>;

function unrealPreset(ue5: boolean): Preset {
  const p: Preset = {
    pelvis: 'Hips',
    neck01: 'Neck', head: 'Head',
  };
  if (ue5) Object.assign(p, { spine01: 'Spine', spine03: 'Spine1', spine05: 'Spine2' });
  else Object.assign(p, { spine01: 'Spine', spine02: 'Spine1', spine03: 'Spine2' });
  for (const [s, Side] of [['l', 'Left'], ['r', 'Right']] as const) {
    Object.assign(p, {
      [`clavicle${s}`]: `${Side}Shoulder`, [`upperarm${s}`]: `${Side}Arm`, [`lowerarm${s}`]: `${Side}ForeArm`,
      [`hand${s}`]: `${Side}Hand`, [`thigh${s}`]: `${Side}UpLeg`, [`calf${s}`]: `${Side}Leg`,
      [`foot${s}`]: `${Side}Foot`, [`ball${s}`]: `${Side}ToeBase`,
    });
    for (const f of FINGERS) {
      const ue = f.toLowerCase();
      for (let i = 1; i <= 3; i++) p[`${ue}0${i}${s}`] = `${Side}Hand${f}${i}`;
    }
  }
  return p;
}

function bipedPreset(): Preset {
  const p: Preset = {
    bip01pelvis: 'Hips', bip01spine: 'Spine', bip01spine1: 'Spine1', bip01spine2: 'Spine2',
    bip01neck: 'Neck', bip01head: 'Head',
  };
  for (const [s, Side] of [['l', 'Left'], ['r', 'Right']] as const) {
    Object.assign(p, {
      [`bip01${s}clavicle`]: `${Side}Shoulder`, [`bip01${s}upperarm`]: `${Side}Arm`,
      [`bip01${s}forearm`]: `${Side}ForeArm`, [`bip01${s}hand`]: `${Side}Hand`,
      [`bip01${s}thigh`]: `${Side}UpLeg`, [`bip01${s}calf`]: `${Side}Leg`,
      [`bip01${s}foot`]: `${Side}Foot`, [`bip01${s}toe0`]: `${Side}ToeBase`,
    });
    FINGERS.forEach((f, fi) => {
      p[`bip01${s}finger${fi}`] = `${Side}Hand${f}1`;
      p[`bip01${s}finger${fi}1`] = `${Side}Hand${f}2`;
      p[`bip01${s}finger${fi}2`] = `${Side}Hand${f}3`;
    });
  }
  return p;
}

const UE4 = unrealPreset(false);
const UE5 = unrealPreset(true);
const BIPED = bipedPreset();

/** Last-resort name guessing for unfamiliar rigs. */
function guess(raw: string): string | null {
  const lower = raw.toLowerCase();
  const k = key(raw);
  const side = /left|(^|[\s_.\-])l([\s_.\-]|$)|_l$|\.l$/.test(lower) ? 'Left'
    : /right|(^|[\s_.\-])r([\s_.\-]|$)|_r$|\.r$/.test(lower) ? 'Right' : null;
  if (/pelvis|hips?$/.test(k)) return 'Hips';
  if (/head$/.test(k) && !side) return 'Head';
  if (/neck/.test(k) && !side) return 'Neck';
  if (!side) {
    if (/chest|spine2|spine03|upperchest/.test(k)) return 'Spine2';
    if (/spine1|spine02/.test(k)) return 'Spine1';
    if (/spine|torso|abdomen/.test(k)) return 'Spine';
    return null;
  }
  if (/clavicle|collar|shoulder/.test(k)) return `${side}Shoulder`;
  if (/forearm|lowerarm|elbow/.test(k)) return `${side}ForeArm`;
  if (/upperarm|(^|[^a-z])arm/.test(k) || /arm$/.test(k)) return `${side}Arm`;
  if (/hand|wrist/.test(k) && !/finger|thumb|index|middle|ring|pinky/.test(k)) return `${side}Hand`;
  if (/thigh|upleg|upperleg/.test(k)) return `${side}UpLeg`;
  if (/calf|shin|knee|lowerleg|leg$/.test(k)) return `${side}Leg`;
  if (/foot|ankle/.test(k)) return `${side}Foot`;
  if (/toe|ball/.test(k)) return `${side}ToeBase`;
  return null;
}

export type RigKind = 'mixamo' | 'unreal4' | 'unreal5' | 'biped' | 'custom' | 'unknown';

/** Inspects all bone names and decides which naming preset applies. */
export function detectRigKind(names: string[]): RigKind {
  const keys = names.map((n) => key(stripPrefix(n)));
  const has = (k: string) => keys.includes(k);
  if (names.some((n) => /mixamorig/i.test(n)) || (has('hips') && has('leftupleg'))) return 'mixamo';
  if (has('pelvis') && keys.some((k) => /^(thigh|upperarm|calf)[lr]$/.test(k))) return has('spine05') ? 'unreal5' : 'unreal4';
  if (keys.some((k) => k.startsWith('bip01') || k.startsWith('bip001'))) return 'biped';
  return 'unknown';
}

/**
 * Maps every source bone name to a canonical Mixamo name (or null).
 * `custom` entries (source name -> canonical) win over presets.
 * The mapping is one-to-one: a canonical bone is claimed by the first match.
 */
export function mapBones(names: string[], custom: Record<string, string> = {}): Record<string, string | null> {
  const kind = detectRigKind(names);
  const preset = kind === 'unreal4' ? UE4 : kind === 'unreal5' ? UE5 : kind === 'biped' ? BIPED : null;
  const out: Record<string, string | null> = {};
  const used = new Set<string>();
  const claim = (name: string, canon: string | null | undefined) => {
    if (canon && !used.has(canon)) { used.add(canon); out[name] = canon; return true; }
    return false;
  };
  // Pass 1: explicit and exact matches.
  for (const name of names) {
    if (name in out) continue;
    out[name] = null;
    if (claim(name, custom[name])) continue;
    const stripped = stripPrefix(name);
    if (claim(name, MIXAMO_LOOKUP.get(stripped.toLowerCase()))) continue;
    const k = key(stripped).replace(/^bip001/, 'bip01');
    if (preset && claim(name, preset[k])) continue;
  }
  // Pass 2: heuristics for whatever is left (only on unknown rigs).
  if (kind === 'unknown') {
    for (const name of names) if (!out[name]) claim(name, guess(stripPrefix(name)));
  }
  return out;
}

export function coverage(mapping: Record<string, string | null>): number {
  const mapped = new Set(Object.values(mapping).filter(Boolean) as string[]);
  let core = 0;
  for (const b of CORE_BONES) if (mapped.has(b)) core++;
  return core / CORE_BONES.size;
}

/** Left/right counterpart of a canonical bone, used by pose mirroring. */
export function mirrorName(canonical: string): string {
  if (canonical.startsWith('Left')) return 'Right' + canonical.slice(4);
  if (canonical.startsWith('Right')) return 'Left' + canonical.slice(5);
  return canonical;
}

export const _internal = { guess };
