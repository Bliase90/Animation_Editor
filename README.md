# Animation Editor

A local animation editor for game characters with Mixamo rigs (for example Tripo3D models auto-rigged in Mixamo). Use it to show an AI exactly the motion you want:

- **Open your character** (FBX, GLB or glTF).
- **Import whole animation packs** (Mixamo downloads, Unreal-style packs such as a combat pack, converted game animations) into a searchable library. Every clip is retargeted onto your character automatically.
- **Pose the character by its joints** (click a joint, drag the rotate gizmo or type angles), mirror poses, and **key poses on a timeline** to block out a new animation or fix an existing one.
- **Write direction notes** ("heavier windup, 0.4 s hold at the top") next to the motion.
- **Export a reference pack** (contact sheets from several angles, per-frame joint angles as JSON, your notes), a video, or a GLB with the clip.
- **Let Claude Code or Codex drive it live** over MCP: they can browse your library, play clips, read and set joint rotations, build clips from key poses, and *see* the result through rendered images.

Everything runs on your machine. Nothing is uploaded.

## Quick start

Requires [Node.js](https://nodejs.org) 20 or newer.

```bash
git clone https://github.com/Bliase90/Animation_Editor.git
cd Animation_Editor
npm install
npm start          # builds the editor and serves it with the AI bridge
```

Open <http://127.0.0.1:7878>.

**On Windows** you can skip the commands: install Node.js LTS (from [nodejs.org](https://nodejs.org) or `winget install OpenJS.NodeJS.LTS`), then double-click `start.bat`. It installs what it needs the first time and opens the editor in your browser. Keep its window open while you work. You start with a built-in mannequin; click **Open model…** to load your own character.

For development with hot reload use `npm run dev` and open <http://127.0.0.1:5173>.

## Using the editor

| Action | How |
| --- | --- |
| Open a character | **Open model…**, or drop the file on the viewport |
| Import animations | **Import files…** or **Import folder…** (each top folder becomes a pack), or drop files/folders on the viewport |
| Play a clip | Click it in the library. **In place** removes forward travel |
| Pose a joint | Click a joint (green = left side, orange = right). Drag the gizmo or use the X/Y/Z fields. **W** moves the hips, **E** rotates, **Esc** deselects |
| New animation | **New clip** (starts from the current pose), pose, move the playhead, pose, **K** to key. Drag keys to retime them |
| Fix an existing clip | Play it, **Edit this animation** (keys every 5 frames), adjust, **K**, **Save to library** |
| Mirror | **Mirror L→R**, **Mirror R→L**, **Flip** |
| Explain it | Type in **Direction notes for the AI**, then **Reference pack** |

Joint angles are always shown as *degrees away from the T-pose* in the character's own axes (X = pitch, Y = turn, Z = roll), which is also what the AI tools use.

Your library, notes, the clip you are editing and the last opened model are kept in the browser's storage between sessions. Your files on disk are never changed.

## Connect Claude Code and Codex

The bridge (`bridge/server.mjs`, started by `npm start` or `npm run dev`) exposes the editor as an MCP server. The editor must be open in a browser for tools to work; if it is not, the bridge opens it for you.

### Claude Code (CLI and desktop)

Inside this repository there is nothing to do: `.mcp.json` registers the server, and Claude Code asks you to approve it the first time.

To use it from any folder, add it once at user scope. Either point at the running bridge:

```bash
claude mcp add --scope user --transport http animation-editor http://127.0.0.1:7878/mcp
```

or let Claude Code start the bridge itself when needed (no `npm start` required beforehand):

```bash
claude mcp add --scope user animation-editor -- node /full/path/to/Animation_Editor/bridge/stdio.mjs
```

Check it with `/mcp` inside Claude Code.

### Codex (CLI, IDE extension and app)

Add this to `~/.codex/config.toml` (on Windows `%USERPROFILE%\.codex\config.toml`, and use forward slashes in the path):

```toml
[mcp_servers.animation-editor]
command = "node"
args = ["/full/path/to/Animation_Editor/bridge/stdio.mjs"]
startup_timeout_sec = 30
tool_timeout_sec = 900
```

Or run `codex mcp add animation-editor -- node /full/path/to/Animation_Editor/bridge/stdio.mjs`. Codex versions with HTTP MCP support can instead use `url = "http://127.0.0.1:7878/mcp"`.

### What the AI can do

`editor_status`, `get_direction_notes`, `set_direction_notes`, `load_model`, `import_animations`, `import_status`, `list_animations`, `play_animation`, `transport`, `list_joints`, `get_pose`, `set_pose`, `reset_pose`, `mirror_pose`, `capture_view`, `contact_sheet`, `describe_animation`, `create_animation`, `key_pose`, `save_animation`, `export`.

See [docs/AI_WORKFLOW.md](docs/AI_WORKFLOW.md) for the pose conventions and example prompts, for example:

> Read my direction notes, look at the "Great Sword Slash" clip in the library, then build a heavier version with a longer windup. Show me a contact sheet when you're done.

### Bridge settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `ANIMATOR_PORT` | `7878` | Bridge port |
| `ANIMATOR_ROOTS` | your home folder | Folders the AI may read models and animations from (separate several with `;` on Windows, `:` elsewhere) |
| `ANIMATOR_EXPORT_DIR` | `~/AnimationEditorExports` | Default folder for AI exports |
| `ANIMATOR_NO_BROWSER` | unset | Set to `1` to stop the bridge opening a browser |

The bridge only listens on 127.0.0.1, rejects other hosts and web origins, and never reads files outside `ANIMATOR_ROOTS`.

## Importing your animation sources

Mixamo, Unreal-style packs (Xplode combat and similar), 3ds Max Biped rigs and game exports are covered in [docs/IMPORTING.md](docs/IMPORTING.md), including what to do with formats that need converting first and how to write a bone map for unusual skeletons.

## Development

```bash
npm run dev        # bridge + Vite dev server
npm test           # unit tests (bone mapping, retargeting)
npm run build && npm run e2e   # drives the real editor through MCP in headless Chromium
npm run typecheck
```

Code map: `src/editor.ts` (state, posing, timeline, export), `src/retarget.ts` (rig capture and retargeting), `src/rig.ts` (bone name mapping), `src/bridge-client.ts` (editor side of the AI link), `bridge/` (MCP server).

Packaging as a desktop app (Electron) is planned once the workflow settles.
