# Importing characters and animations

The editor reads **FBX**, **GLB/glTF** and **BVH**. Every skeleton is matched to Mixamo bone names, so clips from different sources can play on your Tripo3D/Mixamo character. Bone naming is detected automatically for:

| Rig | Example bone names | Detected as |
| --- | --- | --- |
| Mixamo | `mixamorig:Hips`, `mixamorig:LeftForeArm` | `mixamo` |
| Unreal Engine 4 mannequin | `pelvis`, `spine_03`, `upperarm_l`, `calf_r` | `unreal4` |
| Unreal Engine 5 Manny/Quinn | `pelvis`, `spine_05`, `upperarm_l` | `unreal5` |
| 3ds Max Biped | `Bip01 Pelvis`, `Bip01 L UpperArm` | `biped` |
| Anything else | guessed from words like *pelvis*, *thigh*, *forearm*, *_l / _r* | `unknown` |

The **Model** panel shows how many core joints were recognised. Below 80% it warns you; fix that with a bone map (see the end of this page).

Retargeting assumes both rigs stand in a similar rest pose (T-pose to T-pose works best), are Y-up and face forward. A clip authored on an A-pose rig will show the arms offset by the difference.

## Your character (Tripo3D + Mixamo)

1. Export the model from Tripo3D, upload it to [mixamo.com](https://www.mixamo.com) and let Mixamo auto-rig it.
2. Download the rigged character as **FBX Binary, With Skin, T-pose**.
3. In the editor, **Open model…** and pick that FBX (or a GLB you converted it to).

## Mixamo animations

Mixamo has no official bulk download, so you download clips yourself:

1. On Mixamo, pick an animation. Settings: **FBX Binary**, **Without Skin**, **30 FPS**, keyframe reduction **none**. Untick **In Place** unless you want it.
2. Put all downloads in one folder, e.g. `Animations/Mixamo/`. Sub-folders are fine.
3. **Import folder…** and choose `Animations/Mixamo`. The pack is named after the folder.

Mixamo names every clip `mixamo.com`, so the editor uses the file name instead. Name files well (`Great Sword Slash.fbx`) and they are easy to search.

Importing about 2,000 files takes a few minutes; files already in the library are skipped, so you can re-import a folder after adding new downloads.

## Xplode combat pack (and other purchased packs)

- **Delivered as FBX** (most marketplace packs ship an FBX folder): import the folder directly. Unreal mannequin and Mixamo skeletons are recognised automatically.
- **Delivered only as an Unreal project** (`.uasset`): open it in Unreal, select the animation sequences, right-click **Asset Actions → Bulk Export** (or **Export**) as FBX, then import that folder.
- **Delivered for Unity** (`.anim` inside a Unity package): export the clips to FBX with Unity's FBX Exporter package, then import.

## Total War: Warhammer III

Warhammer III animations live inside the game's `.pack` files in Creative Assembly's own `.anim` format, which this editor cannot read directly. To use them:

1. Extract the files you want with a community modding tool such as **RPFM** (Rusted PackFile Manager).
2. Convert the animations together with their skeleton to FBX with a Total War modding tool that supports it (the community **AssetEditor** is the usual choice; check that your version can export animations to FBX).
3. Import the resulting FBX folder. Total War skeletons use their own bone names, so load a bone map (below) the first time.

Extracted game files are the publisher's property. Keep them for personal reference.

## Diablo IV

Diablo IV stores animations in Blizzard's proprietary formats, and there is no exporter we can point to that reliably produces FBX. If you already have Diablo IV animations as FBX or glTF from a tool you trust, import them like any other pack and add a bone map. Otherwise use the editor the other way round: record the motion you liked as a video or block it out with key poses here, and give that to the AI as the reference.

Extracting assets may break the game's terms of use; that decision is yours.

## Other formats

| Format | What to do |
| --- | --- |
| `.blend` | Open in Blender, **File → Export → FBX** (Armature + Mesh, *Bake Animation* on) |
| `.ma` / `.mb` (Maya) | **File → Export Selection → FBX** with *Animation* enabled |
| `.bvh` (mocap) | Imports directly |
| `.dae`, `.anim`, game-specific formats | Convert to FBX in Blender or the game's modding tool first |

## Bone maps for unusual skeletons

If a rig is not recognised, map its bone names to Mixamo names:

1. Open a file that uses that skeleton as the model (**Open model…**).
2. Click **Template** in the Model panel. You get a JSON file listing every bone with its current guess (empty when unknown).
3. Fill in the Mixamo names you need, for example:

   ```json
   {
     "bn_pelvis": "Hips",
     "bn_spine01": "Spine",
     "bn_upperarm_L": "LeftArm",
     "bn_forearm_L": "LeftForeArm"
   }
   ```

   Valid targets are `Hips`, `Spine`, `Spine1`, `Spine2`, `Neck`, `Head`, and per side (`Left…`/`Right…`): `Shoulder`, `Arm`, `ForeArm`, `Hand`, `UpLeg`, `Leg`, `Foot`, `ToeBase`, plus fingers like `LeftHandIndex1`.
4. Click **Bone map…** and load it. The map is remembered; re-open the model and re-import the packs that use that skeleton.
