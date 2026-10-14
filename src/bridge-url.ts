/** WebSocket URL of the local bridge (bridge/server.mjs). `?bridge=ws://…` overrides it. */
export function bridgeWsUrl(): string {
  const param = new URLSearchParams(location.search).get('bridge');
  if (param) return param;
  if (location.port === '7878') return `ws://${location.host}/ws`;
  return 'ws://127.0.0.1:7878/ws';
}

export function bridgeHttpUrl(path: string): string {
  const u = new URL(bridgeWsUrl());
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  u.pathname = path;
  u.search = '';
  return u.toString();
}

/** Asks the bridge to convert a .blend file to GLB with the user's Blender. */
export async function convertBlend(name: string, data: ArrayBuffer): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetch(bridgeHttpUrl('/convert/blend'), { method: 'POST', body: data, headers: { 'x-filename': name.replace(/[^\x20-\x7e]/g, '_') } });
  } catch {
    throw new Error('Opening .blend files needs the local bridge. Start the editor with start.bat or "npm start".');
  }
  if (!res.ok) throw new Error(await res.text());
  return res.arrayBuffer();
}
