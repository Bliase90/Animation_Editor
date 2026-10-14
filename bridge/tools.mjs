// MCP tool definitions for the Animation Editor. Each tool forwards to the
// editor running in the browser through `callApp`.

import { z } from 'zod';

const VIEW = z.enum(['front', 'back', 'left', 'right', 'three_quarter', 'top', 'current']);
const ROT = z.object({
  rotation_deg: z.array(z.number()).length(3).describe('[x, y, z] degrees away from the T-pose. X pitches (bends forward/back), Y turns, Z rolls/raises sideways, in the character\'s own axes.'),
});
const JOINTS = z.record(z.string(), ROT).describe('Map of joint name (e.g. "LeftArm", "Spine1", "RightUpLeg") to its rotation.');

const json = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 1) }] });
const image = (b64) => ({ type: 'image', data: b64, mimeType: 'image/png' });

export function registerTools(server, { callApp, appConnected, files }) {
  const tool = (name, description, inputSchema, handler) => server.registerTool(name, { description, inputSchema }, async (args) => {
    try { return await handler(args ?? {}); }
    catch (e) { return { isError: true, content: [{ type: 'text', text: e?.message ?? String(e) }] }; }
  });

  tool('editor_status',
    'Shows whether the editor is open, which character and animation are loaded, the clip being edited, the library size and the user\'s direction notes. Call this first.',
    {},
    async () => {
      if (!appConnected()) {
        try { return json({ editor_open: true, ...(await callApp('status', {}, 30000, 8000)) }); }
        catch (e) { return json({ editor_open: false, message: e.message, editor_url: files.appUrl(), allowed_folders: files.roots }); }
      }
      return json({ editor_open: true, ...(await callApp('status')), allowed_folders: files.roots, export_folder: files.exportDir });
    });

  tool('get_direction_notes',
    'Reads the notes the user wrote in the editor describing the motion they want (timing, weight, intent, what is wrong).',
    {},
    async () => json(await callApp('get_notes')));

  tool('set_direction_notes',
    'Writes or appends to the direction notes panel, e.g. to summarise your interpretation for the user to confirm.',
    { text: z.string(), append: z.boolean().optional().describe('Add below the existing notes instead of replacing them.') },
    async (a) => json(await callApp('set_notes', a)));

  tool('load_model',
    'Opens a rigged character (FBX, GLB or glTF with a Mixamo-style skeleton) from a path on the user\'s computer. Clips inside the file are added to the library.',
    { path: z.string().describe('Absolute path, or ~/… for the home folder.') },
    async ({ path: p }) => {
      const full = files.checkPath(p, 'model');
      const name = full.split(/[\\/]/).pop();
      return json(await callApp('load_model', { url: files.fileUrl(full), name }, 5 * 60 * 1000));
    });

  tool('import_animations',
    'Imports animation files into the editor\'s library from a file or a whole folder (searched recursively for FBX, GLB, glTF and BVH). Runs in the background; use import_status to follow it. Clips are retargeted onto the character when played.',
    {
      path: z.string(),
      pack: z.string().optional().describe('Library pack name, e.g. "Mixamo", "Xplode Combat". Defaults to the folder name.'),
    },
    async ({ path: p, pack }) => {
      const job = await files.startImport(p, pack);
      return json({ started: true, pack: job.pack, files: job.total, hint: 'Call import_status to see progress.' });
    });

  tool('import_status', 'Progress of the last import_animations run.', {}, async () => {
    const job = files.importJob();
    if (!job) return json({ running: false, message: 'No import has been started.' });
    return json({ ...job, errors: job.errors.slice(0, 30), error_count: job.errors.length });
  });

  tool('list_animations',
    'Searches the animation library (everything the user imported: Mixamo, game packs, their own clips). All words in the query must match the name, pack or file.',
    {
      query: z.string().optional(),
      pack: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
      offset: z.number().int().min(0).optional(),
    },
    async (a) => json(await callApp('list_animations', a)));

  tool('play_animation',
    'Plays a library animation on the character (retargeted automatically). `name` can be an id, an exact name or part of a name.',
    {
      name: z.string(),
      in_place: z.boolean().optional().describe('Remove forward travel so the character animates on the spot.'),
      speed: z.number().min(0.05).max(4).optional(),
      loop: z.boolean().optional(),
      autoplay: z.boolean().optional().describe('false loads it paused.'),
      time: z.number().optional().describe('Pause at this time in seconds.'),
    },
    async (a) => json(await callApp('play_animation', a)));

  tool('transport',
    'Play, pause or scrub the active animation.',
    { action: z.enum(['play', 'pause']).optional(), time: z.number().optional().describe('Jump to this time (seconds) and pause.') },
    async (a) => json(await callApp('transport', a)));

  tool('list_joints',
    'Lists the joint names you can read and pose on the loaded character, plus bones that could not be matched to Mixamo names.',
    {},
    async () => json(await callApp('list_joints')));

  tool('get_pose',
    'Reads the current pose: for each joint its rotation away from the T-pose (degrees, character axes) and its position in metres (feet at Y = 0, character faces +Z, its left is +X).',
    { joints: z.array(z.string()).optional().describe('Only these joints. Default: all mapped joints.') },
    async (a) => json(await callApp('get_pose', a)));

  tool('set_pose',
    'Poses joints. Rotations are degrees away from the T-pose in character axes, applied as if parent joints were at rest. Examples: LeftArm [0,0,-75] lowers the left arm to the side; RightArm [0,0,75] lowers the right arm; LeftForeArm [0,-90,0] bends the left elbow forward; Spine [20,0,0] bends the torso forward; LeftUpLeg [-60,0,0] lifts the left knee forward; LeftLeg [90,0,0] bends the left knee back. Check the result with capture_view.',
    {
      joints: JOINTS,
      mode: z.enum(['absolute', 'relative']).optional().describe('absolute (default) replaces each joint rotation; relative adds to it.'),
      hips_offset_m: z.array(z.number()).length(3).optional().describe('Move the hips by [x, y, z] metres from rest, e.g. [0,-0.3,0] to crouch.'),
      reset_first: z.boolean().optional().describe('Return to the T-pose before applying.'),
      time: z.number().optional().describe('Scrub to this time first (seconds).'),
      key: z.boolean().optional().describe('Also store the pose as a key in the clip being edited (creates one if needed).'),
    },
    async (a) => json(await callApp('set_pose', a)));

  tool('reset_pose', 'Returns every joint to the T-pose.', {}, async () => json(await callApp('reset_pose')));

  tool('mirror_pose',
    'Mirrors the pose: copy the left side onto the right, the right onto the left, or flip the whole pose.',
    { mode: z.enum(['left-to-right', 'right-to-left', 'swap']) },
    async (a) => json(await callApp('mirror_pose', a)));

  tool('capture_view',
    'Renders the character as it looks right now and returns the image(s), so you can see the pose. Use several views to judge depth.',
    {
      views: z.array(VIEW).optional().describe('Default ["front"].'),
      size: z.number().int().min(128).max(1536).optional(),
      time: z.number().optional().describe('Scrub to this time first.'),
      show_joints: z.boolean().optional(),
    },
    async (a) => {
      const r = await callApp('capture_view', a);
      return { content: [{ type: 'text', text: `t = ${r.time_s.toFixed(2)}s; views: ${r.images.map((i) => i.view).join(', ')}` }, ...r.images.map((i) => image(i.png_base64))] };
    });

  tool('contact_sheet',
    'Returns one image with evenly spaced frames of an animation (default the active one) from one or more views. The fastest way to understand a whole motion.',
    {
      name: z.string().optional().describe('Library animation to load first.'),
      frames: z.number().int().min(1).max(24).optional(),
      views: z.array(VIEW).optional().describe('Default ["front", "right"].'),
      tile: z.number().int().min(96).max(512).optional(),
    },
    async (a) => {
      const r = await callApp('contact_sheet', a, 5 * 60 * 1000);
      return { content: [{ type: 'text', text: `Contact sheet of "${r.animation}"` }, image(r.png_base64)] };
    });

  tool('describe_animation',
    'Samples an animation into numbers: joint rotations (degrees from T-pose) and positions per frame. Use for precise timing and angles.',
    {
      name: z.string().optional().describe('Library animation; default the active one.'),
      fps: z.number().int().min(1).max(60).optional().describe('Samples per second, default 10.'),
      joints: z.array(z.string()).optional().describe('Limit to these joints to keep the output small.'),
    },
    async (a) => json(await callApp('describe_animation', a, 5 * 60 * 1000)));

  tool('create_animation',
    'Builds a new clip from key poses and plays it. Each key gives joint rotations (degrees from T-pose) at a time; joints not listed stay in the T-pose for that key. The clip opens in the editor timeline so the user can refine it.',
    {
      name: z.string(),
      fps: z.number().int().min(1).max(120).optional(),
      duration: z.number().positive().optional().describe('Seconds; defaults to the last key time.'),
      keys: z.array(z.object({
        time: z.number().min(0),
        joints: JOINTS,
        hips_offset_m: z.array(z.number()).length(3).optional(),
      })).min(1),
      save: z.boolean().optional().describe('Also save to the library under "My clips".'),
      play: z.boolean().optional(),
    },
    async (a) => json(await callApp('create_animation', a)));

  tool('key_pose',
    'Stores the current pose as a key in the clip being edited, at `time` or the playhead.',
    { time: z.number().optional() },
    async (a) => json(await callApp('key_pose', a)));

  tool('save_animation',
    'Saves the clip being edited to the library under "My clips".',
    { name: z.string().optional() },
    async (a) => json(await callApp('save_animation', a)));

  tool('export',
    'Exports from the editor to a file on the user\'s computer. glb = character with the active animation; reference_pack = zip with contact sheets, pose JSON and notes; contact_sheet = PNG; video = WebM of one loop.',
    {
      kind: z.enum(['glb', 'reference_pack', 'contact_sheet', 'video']),
      path: z.string().optional().describe('File or folder to write to. Default: the export folder.'),
      view: VIEW.optional().describe('Camera for video.'),
    },
    async ({ kind, path: p, view }) => {
      const r = await callApp('export', { kind, view }, 10 * 60 * 1000);
      const written = await files.write(p, r.base64, r.filename);
      const content = [{ type: 'text', text: `Wrote ${written}` }];
      if (kind === 'contact_sheet') content.push(image(r.base64));
      return { content };
    });
}
