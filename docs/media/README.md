# Axle in pictures

These are captures of Axle's production Electron renderer, using the isolated
UI-test fixture and simulated vehicle telemetry. No Bluetooth device, real
controller, saved preferences or user data is involved. They demonstrate the
interface and rendering; they are not hardware compatibility evidence.

| File | What it shows |
| --- | --- |
| `axle-banner.svg` | Original vector title art using Axle's application mark. |
| `axle-drive.png` | The driving screen with a connected simulated vehicle. |
| `axle-night-street.png` | Optional Street scene with photographed offline materials. |
| `axle-in-motion.gif` | Actual camera following, encoder-driven wheel motion, boost, reverse and Attack lighting. |

The original banner, UI and rendering code use the repository's
[Apache-2.0 license](../../LICENSE). Captured vehicle geometry retains its
separate rights: the assembly recreation is by **포기남 (Fogeyman)**,
treated under **CC BY-NC 4.0**, with separately licensed LDraw geometry and
unresolved permissions for some embedded meshes and underlying designs.
Screenshots and animation do not transfer ownership or remove those terms.
See the [model license](../../ui/electron/models/tumbler/LICENSE.md),
[rights record](../../ui/electron/models/tumbler/RIGHTS.md) and
[part notices](../../ui/electron/models/tumbler/generated/THIRD-PARTY-NOTICES.md).
Night-street maps and the lighting panorama are CC0 assets from Poly Haven;
their creators and source links are preserved in the
[environment credits](../../ui/electron/environment/README.md).

## Refresh the captures

With the desktop development dependencies installed, run from the repository root:

```sh
npm --prefix ui/electron run build
node ui/electron/scripts/capture-readme.cjs /tmp/axle-readme-frames
```

This updates both PNGs and records 48 actual rendered frames with capture times
into the chosen temporary directory. Capture on a hardware GPU for the detailed
rendering preset. Keep intermediate frames out of the repository.
To encode a compact looping GIF with FFmpeg installed:

```sh
ffmpeg -framerate 6.25 -i /tmp/axle-readme-frames/frame-%03d.png \
  -filter_complex '[0:v]split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a' \
  -loop 0 -y docs/media/axle-in-motion.gif
```

If the GPU cannot capture at the target frame rate, use `timings.json` for the
frame durations. Inspect the resulting images and animation before committing;
there should be no UI error banners, truncated controls or stale renderer frames.
