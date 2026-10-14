import { ANIMATION_EXTENSIONS, extOf } from './loaders';
import type { FileInput } from './loaders';

export interface PickedFile { file: File; path: string }

/** Reads files and folders from a drop, keeping their relative paths. */
export async function filesFromDrop(dt: DataTransfer): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
  if (!entries.length) return [...dt.files].map((file) => ({ file, path: file.name }));
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ file, path: prefix + entry.name });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      let batch: FileSystemEntry[];
      do {
        batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
      } while (batch.length);
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}

export function filesFromInput(input: HTMLInputElement): PickedFile[] {
  return [...(input.files ?? [])].map((file) => ({ file, path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name }));
}

const dirOf = (p: string) => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';

/** Files in the same folder as `main`, for glTF buffers and textures. */
export function siblingsOf(main: PickedFile, all: PickedFile[]): Map<string, Blob> {
  const dir = dirOf(main.path);
  const map = new Map<string, Blob>();
  for (const f of all) {
    if (f !== main && dirOf(f.path) === dir && !ANIMATION_EXTENSIONS.includes(extOf(f.path))) map.set(f.file.name, f.file);
  }
  return map;
}

export async function toInput(main: PickedFile, all: PickedFile[]): Promise<FileInput> {
  const needsSiblings = extOf(main.path) === 'gltf' || extOf(main.path) === 'fbx';
  return { name: main.file.name, data: await main.file.arrayBuffer(), siblings: needsSiblings ? siblingsOf(main, all) : undefined };
}

/** Pack name for a picked file: its top folder, or a fallback for loose files. */
export function packOf(f: PickedFile, fallback: string): string {
  const parts = f.path.split('/');
  return parts.length > 1 ? parts[0] : fallback;
}

export function saveBlob(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function canvasToBlob(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode image'))), 'image/png'));
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

export const safeName = (s: string) => s.replace(/[^\w\- ]+/g, '_').trim() || 'animation';
