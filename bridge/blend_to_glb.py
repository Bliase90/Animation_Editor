# Converts a .blend file to GLB (mesh, armature and every action) for the
# Animation Editor. Run by bridge/blender.mjs as:
#   blender --background --factory-startup --python blend_to_glb.py -- in.blend out.glb
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1:]
src, out = argv[0], argv[1]

bpy.ops.wm.open_mainfile(filepath=src, load_ui=False)

# Hidden or excluded objects are skipped by the exporter's defaults; make
# armatures and meshes visible so a character saved mid-edit still exports.
for ob in bpy.data.objects:
    if ob.type in {"ARMATURE", "MESH"}:
        ob.hide_viewport = False
        try:
            ob.hide_set(False)
        except RuntimeError:
            pass

options = dict(
    filepath=out,
    export_format="GLB",
    export_animations=True,
    export_skins=True,
    export_yup=True,
    export_apply=False,
)
try:
    # Blender 3.6+: export every action, not only the active one.
    bpy.ops.export_scene.gltf(export_animation_mode="ACTIONS", **options)
except TypeError:
    bpy.ops.export_scene.gltf(**options)

actions = [a.name for a in bpy.data.actions]
print(f"ANIMATION_EDITOR_OK {len(actions)} actions: {', '.join(actions[:20])}")
