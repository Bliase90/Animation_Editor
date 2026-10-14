import type { Editor } from './editor';
import type { ViewName } from './viewer';
import { buildGlb, buildReferencePack } from './exports';
import { bytesToBase64, canvasToBlob } from './files';
import { MIXAMO_BONES } from './rig';

/**
 * Connects the editor to the local bridge (bridge/server.mjs), which exposes
 * it to Claude Code and Codex as MCP tools. Every tool call arrives here as a
 * { id, method, params } message and is answered with { id, result | error }.
 */
export class BridgeClient {
  private retry = 0;

  constructor(private editor: Editor, private onState: (connected: boolean) => void) {}

  get url(): string {
    const param = new URLSearchParams(location.search).get('bridge');
    if (param) return param;
    if (location.port === '7878') return `ws://${location.host}/ws`;
    return 'ws://127.0.0.1:7878/ws';
  }

  start() {
    const ws = new WebSocket(this.url);
    ws.onopen = () => {
      this.retry = 0;
      this.onState(true);
      ws.send(JSON.stringify({ event: 'hello', app: 'animation-editor', version: 1 }));
    };
    ws.onclose = () => {
      this.onState(false);
      // Quietly keep trying; the bridge is optional.
      setTimeout(() => this.start(), Math.min(10000, 1000 * 2 ** this.retry++));
    };
    ws.onerror = () => ws.close();
    ws.onmessage = async (ev) => {
      let msg: { id: string; method: string; params?: Record<string, unknown> };
      try { msg = JSON.parse(ev.data as string); } catch { return; }
      if (!msg.id || !msg.method) return;
      try {
        const result = await this.handle(msg.method, msg.params ?? {});
        ws.send(JSON.stringify({ id: msg.id, result }));
      } catch (e) {
        ws.send(JSON.stringify({ id: msg.id, error: (e as Error).message ?? String(e) }));
      }
    };
  }

  private async handle(method: string, p: Record<string, any>): Promise<unknown> {
    const ed = this.editor;
    const lib = ed.library;
    switch (method) {
      case 'status': {
        const m = ed.model;
        return {
          model: m ? { name: m.name, bones: m.bones.length, mapped_joints: m.byCanon.size, rig: m.rig.kind, core_coverage: Math.round(ed.mappingCoverage() * 100) / 100 } : null,
          animation: ed.clip ? { name: ed.clipLabel, duration_s: ed.duration, time_s: ed.time, playing: ed.playing, in_place: ed.inPlace } : null,
          editing: ed.edit ? { name: ed.edit.name, duration_s: ed.edit.duration, fps: ed.edit.fps, key_times: ed.edit.keys.map((k) => k.time), saved: ed.editSaved } : null,
          selected_joint: ed.selectedBone ? ed.boneLabel(ed.selectedBone) : null,
          library: { animations: lib.items.length, packs: lib.sources() },
          notes: ed.notes,
        };
      }
      case 'list_animations': {
        const items = lib.search(p.query ?? '', p.pack ?? '');
        const offset = p.offset ?? 0, limit = Math.min(p.limit ?? 50, 500);
        return {
          total: items.length,
          items: items.slice(offset, offset + limit).map((m) => ({ id: m.id, name: m.name, pack: m.source, file: m.file, duration_s: Math.round(m.duration * 100) / 100 })),
        };
      }
      case 'list_joints': {
        const m = ed.model;
        if (!m) throw new Error('No model loaded.');
        const order = new Map(MIXAMO_BONES.map((b, i) => [b, i]));
        return {
          joints: [...m.byCanon.keys()].sort((a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999)),
          unmapped_bones: m.rig.bones.filter((b) => !b.canonical).map((b) => b.name),
        };
      }
      case 'load_model': {
        const data = await fetchBytes(p.url);
        const asset = await ed.openModel({ name: p.name, data });
        return { loaded: p.name, animations_found: asset.clips.map((c) => c.name) };
      }
      case 'import_animations': {
        let clips = 0;
        const errors: string[] = [];
        for (const f of p.files as { url: string; path: string; pack: string }[]) {
          const data = await fetchBytes(f.url);
          const r = await ed.importAnimations([{ name: f.path.replace(/^.*[\\/]/, ''), data, source: f.pack, path: f.path }]);
          clips += r.clips;
          errors.push(...r.errors);
        }
        return { imported: clips, errors: errors.slice(0, 50), library_total: lib.items.length };
      }
      case 'play_animation': {
        if (typeof p.in_place === 'boolean') ed.inPlace = p.in_place;
        if (typeof p.speed === 'number') ed.speed = p.speed;
        if (typeof p.loop === 'boolean') ed.loop = p.loop;
        const meta = await ed.playLibraryClip(p.name, p.autoplay ?? true);
        if (typeof p.time === 'number') { ed.pause(); ed.setTime(p.time); }
        return { playing: meta.name, pack: meta.source, duration_s: meta.duration };
      }
      case 'transport': {
        if (p.action === 'play') ed.play();
        else if (p.action === 'pause') ed.pause();
        if (typeof p.time === 'number') { ed.pause(); ed.setTime(p.time); }
        return { time_s: ed.time, duration_s: ed.duration, playing: ed.playing };
      }
      case 'get_pose':
        return ed.getPose(p.joints);
      case 'set_pose':
        if (p.time !== undefined) { ed.pause(); ed.setTime(p.time); }
        if (p.reset_first) ed.resetPose();
        ed.setPose(p.joints ?? {}, p.mode ?? 'absolute', p.hips_offset_m);
        if (p.key) ed.keyPose(p.time ?? ed.time);
        return ed.getPose(Object.keys(p.joints ?? {}));
      case 'reset_pose':
        ed.resetPose();
        return { ok: true };
      case 'mirror_pose':
        ed.mirrorPose(p.mode ?? 'left-to-right');
        return { ok: true };
      case 'capture_view': {
        if (typeof p.time === 'number') { ed.pause(); ed.setTime(p.time); }
        const views: ViewName[] = p.views?.length ? p.views : ['front'];
        const size = Math.min(p.size ?? 640, 1536);
        const images = [];
        ed.joints.visible = !!p.show_joints;
        for (const v of views) images.push({ view: v, png_base64: ed.viewer.capture(v, size, size).split(',')[1] });
        ed.joints.visible = true;
        return { images, time_s: ed.time };
      }
      case 'contact_sheet': {
        if (p.name) await ed.playLibraryClip(p.name, false);
        const sheet = ed.contactSheet(Math.max(1, Math.min(p.frames ?? 8, 24)), p.views ?? ['front', 'right'], Math.min(p.tile ?? 256, 512));
        return { png_base64: sheet.toDataURL('image/png').split(',')[1], animation: ed.clipLabel };
      }
      case 'describe_animation': {
        if (p.name) await ed.playLibraryClip(p.name, false);
        return ed.describeClip(Math.max(1, Math.min(p.fps ?? 10, 60)), p.joints);
      }
      case 'create_animation': {
        ed.createClipFromPoses(p.name ?? 'AI clip', p.fps ?? 30, p.keys, p.duration);
        let saved = null;
        if (p.save) saved = (await ed.saveEditToLibrary()).id;
        if (p.play ?? true) ed.play();
        return { name: ed.edit?.name, duration_s: ed.duration, keys: ed.edit?.keys.map((k) => k.time), saved_id: saved };
      }
      case 'key_pose':
        return { keyed_at: ed.keyPose(p.time ?? ed.time), keys: ed.edit?.keys.map((k) => k.time) };
      case 'save_animation': {
        if (p.name) ed.setEditProps({ name: p.name });
        const meta = await ed.saveEditToLibrary();
        return { saved: meta.name, id: meta.id };
      }
      case 'get_notes':
        return { notes: ed.notes };
      case 'set_notes':
        await ed.setNotes(p.append ? `${ed.notes}${ed.notes ? '\n\n' : ''}${p.text}` : p.text);
        return { notes: ed.notes };
      case 'export': {
        if (p.kind === 'glb') { const r = await buildGlb(ed); return { filename: r.name, base64: bytesToBase64(r.bytes) }; }
        if (p.kind === 'reference_pack') { const r = await buildReferencePack(ed); return { filename: r.name, base64: bytesToBase64(r.bytes) }; }
        if (p.kind === 'video') {
          const blob = await ed.recordVideo(p.view ?? 'three_quarter');
          return { filename: `${ed.clipLabel || 'clip'}.webm`, base64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())) };
        }
        if (p.kind === 'contact_sheet') {
          const blob = await canvasToBlob(ed.contactSheet(8, ['front', 'right', 'three_quarter'], 256));
          return { filename: `${ed.clipLabel || 'pose'}_sheet.png`, base64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())) };
        }
        throw new Error(`Unknown export kind "${p.kind}".`);
      }
      default:
        throw new Error(`Unknown method ${method}`);
    }
  }
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not read file from the bridge (${res.status}): ${await res.text()}`);
  return res.arrayBuffer();
}
