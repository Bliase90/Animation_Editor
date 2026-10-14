import { zipSync, strToU8 } from 'fflate';
import type { Editor } from './editor';
import { canvasToBlob, safeName } from './files';

const README = `Animation reference pack
========================

Made with Animation Editor to show an AI (Claude, Codex, GPT) the motion I want.

- notes.md            what I want, in my own words
- sheet.png           evenly spaced frames from the front and the right side
- sheet_34.png        the same frames from a three-quarter view
- pose.json           every joint per frame, Mixamo bone names
                      rotation_deg = degrees away from the T-pose, XYZ order,
                      in character axes (X = character's left, Y = up, Z = forward)
                      position_m   = joint position in metres, feet on Y = 0
`;

export async function buildReferencePack(editor: Editor): Promise<{ name: string; bytes: Uint8Array }> {
  const name = safeName(editor.clipLabel || 'pose');
  const frames = editor.clip ? 8 : 1;
  const sheet = editor.contactSheet(frames, ['front', 'right'], 256);
  const sheet34 = editor.contactSheet(frames, ['three_quarter'], 256);
  const pose = editor.clip ? editor.describeClip(10) : { format: 'animation-editor/pose@1', notes: editor.notes, pose: editor.getPose() };
  const files: Record<string, Uint8Array> = {
    'README.txt': strToU8(README),
    'notes.md': strToU8(`# ${editor.clipLabel || 'Pose'}\n\n${editor.notes || '(no notes)'}\n`),
    'pose.json': strToU8(JSON.stringify(pose, null, 1)),
    'sheet.png': new Uint8Array(await (await canvasToBlob(sheet)).arrayBuffer()),
    'sheet_34.png': new Uint8Array(await (await canvasToBlob(sheet34)).arrayBuffer()),
  };
  return { name: `${name}_reference.zip`, bytes: zipSync(files, { level: 6 }) };
}

export async function buildGlb(editor: Editor): Promise<{ name: string; bytes: Uint8Array }> {
  const clips = editor.clip ? [editor.clip] : [];
  const buf = await editor.exportGLB(clips);
  return { name: `${safeName(editor.model?.name.replace(/\.[^.]+$/, '') ?? 'model')}${editor.clip ? '_' + safeName(editor.clipLabel) : ''}.glb`, bytes: new Uint8Array(buf) };
}
