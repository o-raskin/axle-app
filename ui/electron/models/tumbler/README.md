# Unofficial model of the LEGO® Technic™ 42239 Tumbler

This is a third-party reconstruction, **not an Axle-owned vehicle design**.
The assembly was published by **포기남 (Fogeyman)** with **CC BY-NC 4.0**
terms. LDraw part geometry belongs to its individual contributors; several
Studio fallback meshes have incomplete license evidence. The application's
Apache-2.0 license does not relicense these assets or permit commercial reuse
of the assembly. See [LICENSE.md](LICENSE.md), [RIGHTS.md](RIGHTS.md), and the
[source evidence](source/LICENSE-EVIDENCE.md) before redistributing it.

LEGO® is a trademark of the LEGO Group, which does not sponsor, authorize, or
endorse this project. Batman™, Batmobile™ and their related elements involve
separate DC/Warner Bros. rights; see [RIGHTS.md](RIGHTS.md). Axle is independent
of those parties and of the reconstruction's publisher.

This Electron package retains the editable model, all local geometry dependencies,
conversion tools, and provenance. The app loads one local
GLB; it never downloads model parts or textures at runtime.

The assembly is adapted from [Fogeyman's Studio reconstruction](https://fogeyman.tistory.com/1770)
and checked against [LEGO's official building instructions](https://www.lego.com/en-us/service/building-instructions/42239).
It replaces the earlier procedural vehicle with real Technic panels, perforated
liftarms, exposed connectors, an open cockpit, and six tires with paired rears.

## Editable files

`source/cad-source.zip` stores the 441 original CAD/dependency files losslessly.
It also contains `ARCHIVE-NOTICE.md` with author, license, rights-gap and source
evidence records, plus a SHA-256 inventory covering every archived file.
The converter reads it directly, without unpacking it or fetching dependencies.
The following CAD paths are **archive entries**, relative to `source/` when
extracted; their original bytes and license/author/history headers remain intact:

- `42239.io`: original Studio project; open with BrickLink Studio after extraction.
- `42239.mpd`: unchanged extracted LDraw assembly, including submodels.
- `custom/`: supplied custom parts and extracted Studio fallbacks; authors and
  evidence gaps are documented separately in [LICENSE.md](LICENSE.md).
- `ldraw/`: only the LDraw parts/primitives required by this assembly and their
  original library agreements.

These files stay readable next to the archive:

- `source/axle-details.mjs`: editable light-guide bends, pin placement, and surface graphics
  reconstructed from the official instruction steps, separate from the original CAD.
- `source/provenance.json`: origin, license, known differences, and original hashes.
- `source/LICENSE-EVIDENCE.md`: what the original publication and retained headers
  establish, and what remains unverified.
- `references.md`: official reference URLs, instruction steps, measured part sizes,
  and a clear distinction between published measurements and inferred placement.
- `generated/rig.json`: geometry bounds, animation pivots, source/dependency hashes,
  and runtime asset statistics.
- `generated/THIRD-PARTY-NOTICES.md`: attribution for the assembly and every used part.

The generated runtime asset is
`../../src/renderer/src/vehicle/assets/tumbler-42239.glb` from this directory.
Model sources are excluded from the installed application; its
model license and part attribution are included separately in application resources.

Consolidation does not remove geometry, materials, light targets, steering/rolling
pivots, rebuild inputs, or license evidence. The app continues to load the same
single GLB. Direct Studio/source edits require extraction, and Git presents archive
changes as a binary diff; these are the workflow tradeoffs. Keep the archive instead
of retaining a second committed copy of its expanded tree.

## Rebuild and inspect

From `ui/electron`, after `npm ci`:

```sh
npm run model:build
npm test
npm run model:preview
npm run build
npm run test:ui
```

For CAD editing, extract the archive, edit the original files, and repack them:

```sh
npm run model:extract -- /tmp/axle-tumbler-edit
# Open/edit the extracted Studio, MPD or part files.
npm run model:pack -- /tmp/axle-tumbler-edit
npm run model:build
```

Retain the original source/license notices when editing. Archive repacking changes
the stored source bundle, so review its manifest and rebuild the GLB before
distributing the changed model. Record actual modifications and update the affected
hashes in `source/provenance.json`; original-publication hash checks intentionally
reject undocumented source changes. Extraction refuses to overwrite an existing
directory. Studio edits to `.io` must also be exported to the MPD/custom files used
by the converter; changing the `.io` project alone does not change the runtime mesh.

Model conversion is fully offline and fails if a local part dependency is missing.
It simplifies individual parts before batching, preserving hard normals and holes,
with a requested approximate error threshold of 0.12 mm. Position/normal quantization
and Meshopt compression produce a local asset of about 7.9 MB, with 903k triangles
in 32 material draws. The original full CAD remains available for further edits.
The app renders on demand while idle, caps animated rendering at30fps, and reuses
its shadow map during camera movement and rolling. Steering changes refresh shadows.
Normal application builds use the checked-in GLB and do not reconvert CAD. Preview
rendering opens an isolated Electron window with no bridge or vehicle connection.
`npm run model:preview` writes inspection images to the ignored local directory
`test-results/tumbler-model/`; these can be regenerated and are not stored with the model.
`AXLE_MODEL_ASSET` and `AXLE_MODEL_PREVIEW_DIR` can select an alternate GLB and output
directory for comparisons.

## Animation and fidelity

The coordinate system is +Y up, +Z forward, wheel rolling about local X, and steering
about Y. The original assembly uses longitudinal X, downward Y and lateral Z; the
converter applies a proper rotation and retains its handedness. Rear wheel pairs
share one rolling pivot on each side. Front wheel yaw pivots coincide with their
axles, instead of their offset part origins.
Their rolling ratio follows the actual tire radii. Mirrored source transforms
retain correct triangle winding after they are baked.

Wheel rotation follows measured drivetrain travel from the hub's POS encoders,
converted through the original 7/11 rear gearing. Rendering remains capped at
30 fps; sample interpolation has a 120 ms delay and preserves the measured
distance independently of rendering frequency. Throttle, speed mode and boost
never substitute for a reading. Stalls, coasting and braking follow actual
encoder changes. Missing feedback pauses rotation; hidden/reduced-motion
intervals are excluded without replaying them on return.

Steering preserves the bridge's command convention: positive means the driver's
right, negative means left. With +Z forward and +Y up in the model, right is -X,
so the viewer maps positive input to negative Y yaw at both front-wheel pivots.
The original smoothing and steering range apply in both directions.

Only control feedback available from the bridge drives the model: steering, wheel
rolling, white front lights/flicker, green reverse lights, and orange rear jet/boost.
The three internal green optical assemblies have separate emissive targets; their
opaque green supports remain ordinary plastic. `rocket_lights_on` carries the bridge's
resolved reverse blink phase and controls those assemblies directly. It never activates
the orange lens. Lit optical bars receive a green transmission tint, restored to their
original clear plastic color when the signal turns off. The set does not have
the invented brake lamps or remotely measured wing position of the previous
illustration. Steering and light commands do not establish an encoder pose;
wheel movement has its own measured feedback. Stale, disconnected, and
mismatched-model feedback must leave the model idle.

Automatic camera following starts enabled. Rear chase views show driving and boost;
a closer left view reveals the flashing rear reverse assembly and both front
green assemblies; an elevated side view accommodates simultaneous front and rear
effects. Steering widens the composition
without switching camera sides. A short dwell ignores transient control changes,
and reverse direction holds its view through blink-off phases.
The reverse composition also remains selected during concurrent boost/attack and
gentle reverse commands, preserving the rear green signal's visibility.
Critically damped orbit/target springs preserve velocity when retargeted and travel around the car
instead of cutting through it. Manual orbit/presets pause following; reduced-motion
preferences disable automatic camera movement.

The Studio project declares 712 modeled bricks versus the official 719-piece
inventory and uses an earlier hub CAD revision. It is a detailed reconstruction,
not a certified complete digital twin. The short front light guides and markings
were missing from the original source; their added bends and graphic geometry are
documented, reference-matched adaptations. The rear guide still follows the source's
routed hose surrogate. Original assembly bytes are preserved.

## License and verification

Read [LICENSE.md](LICENSE.md) before reusing the geometry. The assembly and its
derived assets retain the source publication's **CC BY-NC 4.0** restriction,
separately from the application's Apache-2.0 code. Retained LDraw parts preserve
their individual contributor licenses. The publication does not establish a
complete rights chain for every embedded mesh or grant LEGO/DC vehicle-design
rights. [RIGHTS.md](RIGHTS.md) records those limits; attribution and a disclaimer
are not a guarantee of legal clearance.

Wheel rotation uses measured motor encoder travel and the original drivetrain gearing.
See [wheel feedback](wheel-feedback.md) for the protocol source, passive direction learning,
interpolation and physical verification limits.
