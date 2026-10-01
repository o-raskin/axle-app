# LEGO Technic 42239 Tumbler reference audit

Research checkpoint: 2026-10-01. This model represents **LEGO Technic set 42239**, not the film vehicle, the UCS 76240 model, or another Tumbler set. Measurements below distinguish published part sizes from estimates and CAD reconstruction data.

## Primary references

- [Official LEGO product page](https://www.lego.com/en-us/product/batmobile-tumbler-42239): set identity, 719-piece count, CONTROL+ steering and light functions, and published overall dimensions of approximately **310 mm long × 170 mm wide × 110 mm high**.
- [Official building-instruction page](https://www.lego.com/en-us/service/building-instructions/42239) and [instruction PDF 6675742](https://www.lego.com/cdn/product-assets/product.bi.core.pdf/6675742.pdf): authoritative assembly reference. The PDF is approximately 160 MB; keep its source URL instead of adding the PDF to the application bundle.
- [Official front three-quarter product image](https://www.lego.com/cdn/cs/set/assets/blt0aa9f1c9bd984f96/42239_Prod.png): open windshield frame, nose, front tires, cockpit panels, pin colors, and side liftarms.
- [Official side image](https://www.lego.com/cdn/cs/set/assets/blta75d96b9ed387043/42239_WEB_SEC01_NOBG.png): low front profile, large rear tires, raised cockpit roof, swept side panels, and rear wing frame.
- [Official front lights image](https://www.lego.com/cdn/cs/set/assets/blt9c7f270e6aab48c9/42239_WEB_SEC02_NOBG.png): positions of the two round white headlamps behind the front hood and green internal couplers visible through the cockpit.
- [Official rear image](https://www.lego.com/cdn/cs/set/assets/blt565cec5e6c560de9/42239_WEB_SEC03_NOBG.png): paired rear tires, exposed gray toothed jet surround, orange central lens, and open rear wing structure.
- [Official overhead steering image](https://www.lego.com/cdn/cs/set/assets/blt887101306be386f9/42239_WEB_SEC04_NOBG.png): narrow front track, broad rear track, roof layout, and steering articulation.

The photographs are reference material. They are not application textures or a substitute for editable geometry.

## Wheel inventory and scale

The broad rear wheel appearance is made from **two adjacent tires on each side**. There are six tires in total. A first impression from the product image can incorrectly suggest four tires; the inventory and assembly data resolve this.

[BrickLink inventory](https://www.bricklink.com/catalogItemInv.asp?S=42239-1&viewCodes=Y), recorded from sealed set contents, lists:

| Position | Quantity | Tire | Tire dimensions | Rim |
| --- | ---: | --- | --- | --- |
| Front | 2 | 7683 | 56 × 26 mm | 7655, 30 mm diameter × 20 mm, six pin holes |
| Rear | 4 | 52985 | 68.7 × 27 mm | 56908, 43.2 mm diameter × 26 mm, six pin holes |

The tire radius ratio is **28 / 34.35 ≈ 0.815**. The front and rear treads use close-set road blocks, rather than a small number of large off-road lugs. Rear tire pairs should sit closely together, with a narrow seam; their combined width is approximately 54 mm per side. Outer rims are black plastic and have molded openings, rather than silver spokes or bronze center caps.

## Shapes that define this LEGO set

### Front and steering

- The two front tires sit noticeably inboard of the outer side protection frames. Their tread is rounded at the shoulders.
- A narrow central hood slopes down between the front wheels. Separate thin black panel strips form the broader upper hood, leaving visible gaps and mechanical structure below.
- Front steering is exposed Technic geometry: pins, axle holders, liftarms, and a linkage. Decorative automotive coilovers and metallic suspension rods are not present in the official exterior.
- Side protection uses large open rectangular frames, with circular holes along the upper and lower rails. Black cross-pattern connectors fill part of each frame, but the middle remains visibly open.

### Cockpit and roof

- The windshield and side-window regions are **open**. There is no opaque glass wedge and no continuous sealed cockpit shell.
- Thick sloped Technic pillars support the roof. Red cross-axle ends and blue pin ends remain visible at joints.
- The roof consists of separate flat, tapered black panels with a central seam and perforated liftarm borders. Its silhouette is higher and more squared-off than the previous generic low wedge.
- Two yellow circular graphics sit on each side cockpit rail. These can be reproduced as simple geometry/color details; product logos and photograph textures are unnecessary.

### Sides and rear

- A broad curved/sloping black panel sweeps from the low front toward the high rear shoulder on each side. Lower side panels sit above black rails, with visible circular connection holes.
- Rear wheel pairs extend much farther outward than the front tires. The center engine/jet support fits between the inside rear tires.
- The jet outlet is a light-gray toothed surround with an orange lens in its center. It is not a deep metal turbofan with silver blades.
- The rear wing is open Technic framing: two raised longitudinal panel groups, with a lower transverse beam/panel behind them. Keep the gaps, through-holes, and colored connectors visible.
- Main materials are glossy or satin black plastic, matte black rubber, light/dark gray mechanism details, blue pins, red axle ends, and occasional yellow connectors. Avoid broad blue-gray metal panels and bronze details.

## Downloadable CAD reconstruction

[Fogeyman's Studio reconstruction of 42239](https://fogeyman.tistory.com/m/1770), published 2026-08-12, provides a **42239.io** file and custom **7655.part**, **7683.part**, and **103479c01-3.part** files. The page declares [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) for its material. Any redistribution of that reconstruction requires attribution and preservation of its noncommercial conditions; it does not become covered by the application's general source license.

The author's reconstruction is a useful part-placement reference, but it is not official LEGO CAD. The author explicitly notes that the integrated hub is an older approximation because the updated battery/hub geometry was not available in Studio. The article also contains an AI-retouched comparison image, which must not be used for geometry measurements.

The archive header declares 712 modeled bricks, versus the official 719-piece inventory. This count is not a one-to-one inventory comparison: a recursive placement count also includes flexible-piece placeholder end caps, and the reconstructed hub is an approximation. The reconstruction must not be described as a complete, exact official digital twin.

## Instruction-PDF assembly audit

The following are printed page numbers in [official instruction PDF 6675742](https://www.lego.com/cdn/product-assets/product.bi.core.pdf/6675742.pdf), which has 216 pages. Selected pages were rendered and inspected; the large PDF and render images stay outside the repository. The cover and page 196 provide completed-set comparisons.

| Page | Step | Verified visual finding |
| --- | --- | --- |
| 46 | 45 | Each front internal coupler contains a clear 4L bar, two transparent bright-green cones, and a green round 1×1 plate with an open stud. These are already present in the Studio reconstruction. |
| 53 | 51 | Sticker 1 adds a dark gray bat-shaped graphic to the central front 3×7 panel. |
| 96–98 | 99–103 | A clear 80 mm flexible light guide routes into the center of the orange rear jet lens and bends forward below the gray bracket. The jet retains its light-gray toothed surround. |
| 106–108 | 113–115 | The rear green coupler attaches to the hub and rear assembly. It is separate from the orange external lens. |
| 124 | 127 | Two clear **48 mm** flexible light guides receive black friction-pin ends and connect to the front green couplers. The guides curve forward and upward over the front chassis behind the hood. |
| 125 | 128 | The function test explicitly shows **white** illumination at both external front light-guide tips. The internal green couplers do not establish the external headlight color. |
| 166, 176 | 168, 186 | Sticker 2 adds a pair of gold circular graphics to each small curved panel on the sides. |
| 188 | 208 | The raised rear longitudinal wing groups are assembled as open frames with thin black panels. |
| 189–190 | 209 | A lower transverse rear panel connects across the back beneath the raised wing groups. |
| 191–194 | 210–213 | The completed chassis receives two front tires and four rear tires, including the tightly adjacent rear pairs. |
| 195 | 214 | Side access panels close against the body. Their physical hinges do not establish any remotely measured wing or door position. |
| 196 | Completed | Final front three-quarter assembly: six tires, open cockpit, angular raised roof, exposed pin colors and perforated rails. |
| 214–215 | Inventory | The inventory lists two 48 mm clear light guides, one 80 mm clear light guide, six tires, two green open-stud 1×1 plates, the hub, and the separately counted rechargeable battery. |

### Confirmed source omissions and optical details

The two short front light guides are **40002c06**, LEGO element **6628235**. The rear guide is **40002c10**, element **6454803**. The Studio reconstruction contains no `40002c06` or `40002c10` placement. Its rear flexible assembly is represented by a `76348.dat Copy 3` placeholder, which is useful route evidence but is not the correct light-guide part. An added curved guide must be described as geometry reconstructed from the instructions, not as an exact original Studio part.

The front light-guide tips use black **2780** friction pins. There are 139 such pins in the extracted CAD placements versus 142 in the inventory; the two front guide tips and the rear light-guide connection account for visually identified pin locations that need checking. The count alone cannot establish every missing placement or explain the whole 712/719 difference.

The green open-stud plates in page 46 are **85861**, element **6388221**, and are **not missing**. They already occur in front coupler submodels 9 and 10 with LDraw color 2. Their two `59900` cones use LDraw color 35, while `30374` clear bars use color 47. Do not add duplicate plates or color the external front lamps green.

In the unmodified source coordinate system, coupler groups 9 and 10 are located at approximately **[21.114, −152.292, +59.982]** and **[21.094, −152.302, −60.018]** LDU. Each first cone has local position **[−18, −10, 0]**; the green plate is at **[30, −10, 0]**. These are source placement coordinates. A curved front guide's free route and pin-tip position must be matched to page 124 and the official front-lights photograph; the PDF does not supply measured bend coordinates.

### Reconstructed front light-guide route

The actual converted `59900` part extends in positive local Y. Its front tip is near raw **[3.22, −142.10, +59.98]** LDU, with the mirrored channel near **[3.20, −142.11, −60.02]**. An earlier tentative attachment estimate that assumed a negative-Y cone extent must not be used.

A physically plausible overlay route can preserve the official 48 mm / **120 LDU** full guide length as follows. These are **inferred bend coordinates**, matched to page 124's forward/upward curve; they are not physical measurements or geometry from the Studio archive:

- Start 20 LDU inside the first cone, at **[23.22, −142.10, +59.98]**, and run straight to the actual cone tip **[3.22, −142.10, +59.98]**.
- Follow a cubic Bézier with control points **[−10, −142.10, +59.98]** and **[−15, −162, +59.98]**, ending at **[−35, −162, +59.98]**. Numerically sampled curve length: approximately **44.320 LDU**.
- Continue straight to **[−90.680, −162, +59.98]**, using the remaining **55.680 LDU**. Center the black 2780 pin at **[−70.680, −162, +59.98]** with its axis along raw X; the lit end points forward, toward negative X.
- Mirror the route to Z ≈ −60.02 and retain that channel's slight source-origin offset. Validate the added guides in the completed model through the hood gaps, rather than equating the unrelated exposed upper-hood hinge pins with headlamps.

A guide outer diameter of **3.2 mm / 8 LDU** agrees with the 2780 pin's modeled bore and [BrickLink's catalog dimensions for the 80 mm guide](https://www.bricklink.com/v2/catalog/catalogitem.page?id=242815). This is dimensional evidence for the rendering, not a manufacturer tolerance specification. Any smaller emissive core is a display choice. Keep the external tip white and the internal coupler plastic green.

### Missing surface graphics

The source MPD has no patterned-part references, sticker declarations, texture references, or `TEXMAP` records. The original graphics need a separately documented visual overlay; geometry should remain editable and the source archive should remain unchanged.

- **Nose:** page 53, step 51 applies sticker 1 to root part **71709**, the 3×7 panel. Source placement: **[−150.9583, −121.9996, −0.01824]** LDU. Its flat upper surface is local **Y = −9**; the placement matrix is **[−0.886203, 0.463298, 0; 0.463298, 0.886203, 0; 0, 0, −1]**. The graphic is dark gray against the black panel, not a large yellow badge.
- **Side markings:** page 166, step 168 and page 176, step 186 apply sticker 2 with **two gold circular graphics** to curved part **71682**. In submodel 44, the part origin is **[55.8788, −94.20264, −37.05126]**; the corresponding submodel-45 origin is **[−55.87878, −94.20261, −37.05120]**. The circles sit along the curved outer face of this small panel, rather than on the roof or main swept side panel. The exact printed artwork is not available in the CAD.

## Reconstructed chassis dimensions

The Studio reconstruction uses LDraw units: **1 LDU = 0.4 mm**. Its raw coordinate axes are longitudinal X, downward Y, and lateral Z. For the application's convention, map lateral Z to X, negate Y to make it up, and map the forward longitudinal direction to +Z.

In the reconstructed placement data:

- Front tire longitudinal centers are approximately **−226.3 LDU**, and rear tire centers **389.8 LDU**. Estimated wheelbase: **616.1 LDU ≈ 246.4 mm**.
- Front tire lateral centers are approximately **±90 LDU**, giving about **72 mm** center-to-center front track.
- Rear inner tire lateral centers are **±110 LDU**, and outer tires **±178 LDU**. The 68 LDU separation is about **27.2 mm**, matching the paired 27 mm tires.
- Approximate tire-to-tire rear width is **(178 × 2 × 0.4) + 27 ≈ 169.4 mm**, consistent with LEGO's rounded 170 mm overall width.

These coordinate-derived values are reconstruction evidence, not certified measurements of the physical set. Use the official instructions to settle any part-placement disagreement.

## Replication priorities and verification

1. Preserve the six tires; correct their size, tread, black rims, narrow front track, and closely paired rear spacing.
2. Replace the glass wedge and closed armor shell with an open Technic cockpit, separate roof panels, holey liftarms, and visible connectors.
3. Match the low central nose, front protection frames, swept side panels, and raised open rear wings.
4. Reproduce the round headlamps and gray/orange jet assembly, keeping the animation materials independent.
5. Compare front three-quarter, side, overhead, and rear views against the official images. The silhouette should read as the LEGO set before small connector details are added.
6. Preserve live steering, wheel rolling, light/boost feedback, camera targets, and cleanup behavior. Do not infer wing motion from an attack-light command; the bridge does not provide a measured wing position.
