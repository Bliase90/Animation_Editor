# Working with Claude Code and Codex

Once the MCP server is connected (see the README), the AI works on the same editor window you have open. You see every change it makes, and it sees rendered images of the result.

## Conventions the tools use

- **Joint names** are Mixamo names without the prefix: `Hips`, `Spine`, `Spine1`, `Spine2`, `Neck`, `Head`, `LeftShoulder`, `LeftArm`, `LeftForeArm`, `LeftHand`, `LeftUpLeg`, `LeftLeg`, `LeftFoot`, `LeftToeBase`, the same with `Right`, and fingers such as `RightHandIndex1`. `list_joints` returns the ones the loaded character has.
- **Axes** are the character's own: X points to the character's left, Y up, Z forward. Positions are metres with the feet at Y = 0 (characters are scaled to about 1.8 m).
- **Rotations** (`rotation_deg: [x, y, z]`) are degrees away from the T-pose, applied as if the parent joints were still at rest, Euler order XYZ. Parent rotations then carry the child along, like posing a puppet from the hips outward.

Handy reference values:

| Pose | Joint | rotation_deg |
| --- | --- | --- |
| Arms down by the sides | `LeftArm` / `RightArm` | `[0, 0, -75]` / `[0, 0, 75]` |
| Arm raised overhead | `LeftArm` / `RightArm` | `[0, 0, 80]` / `[0, 0, -80]` |
| Arm forward | `LeftArm` / `RightArm` | `[0, -80, 0]` / `[0, 80, 0]` |
| Elbow bent 90° forward | `LeftForeArm` / `RightForeArm` | `[0, -90, 0]` / `[0, 90, 0]` |
| Lean forward 20° | `Spine` | `[20, 0, 0]` |
| Twist torso to its left | `Spine1` | `[0, 30, 0]` |
| Knee lifted forward | `LeftUpLeg` | `[-60, 0, 0]` |
| Knee bent | `LeftLeg` | `[90, 0, 0]` |
| Crouch | hips offset | `hips_offset_m: [0, -0.3, 0]` |

## A good loop for the AI

1. `editor_status` and `get_direction_notes` to see what is loaded and what you asked for.
2. `list_animations` with a few words (`"sword slash"`) to find similar existing clips, `contact_sheet` to look at them, `describe_animation` with a few joints for exact timing.
3. Block out the motion with `create_animation` (a key every few frames), or `play_animation` an existing clip and adjust with `set_pose` + `key_pose`.
4. Check with `contact_sheet` (front and right views) and `capture_view` at key moments. Fix and repeat.
5. `save_animation`, then `export` a `reference_pack` or `glb` if a file is needed.

## Example prompts

> Read my notes in the animation editor. Find the Mixamo clips closest to what I describe, show me contact sheets of the best two, and tell me which parts match and which don't.

> In the animation editor, block out a 1.2 s two-handed overhead slam: 0.4 s windup with the weapon behind the head, a fast strike, 0.3 s recovery. Key it every 4 frames, save it as "Slam v1" and send me a contact sheet.

> Play "Xplode Combo 03" in place. At 0.6 s the left arm drops too early; fix the keys between 0.5 s and 0.8 s so it stays guarded, then export a reference pack for Astra.

## Sharing with an AI that is not connected

**Reference pack** in the Export panel writes a zip with:

- `notes.md`: your direction notes
- `sheet.png` / `sheet_34.png`: evenly spaced frames from front, side and three-quarter views
- `pose.json`: every joint per frame using the conventions above

Attach the zip (or just the sheet and notes) to any chat.
