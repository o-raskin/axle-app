# Desktop product audit and redesign

## Product intent

The app connects a gamepad to a supported physical vehicle. The most frequent journey is to open
the app, connect the vehicle, drive with the controller, and end the session. The interface should
answer three questions: what can I do now, what is connected, and what should I do next?

This work preserves the Python control engine and the existing Electron separation. It does not
add a second implementation of Bluetooth, motor control, calibration, or gamepad input.

## Starting-point audit

The existing foundation has useful typed IPC, an isolated preload, a sandboxed renderer, a Python
profile catalog, structured progress and telemetry, bounded event history, and interrupt-based
shutdown. Its main weakness is how those implementation details are presented.

| Finding | User impact | Product decision |
| --- | --- | --- |
| Process information, Python profiles, diagnostics, and logs share the first screen | The main action has little priority | Make Drive the primary surface; move technical tools into opt-in Diagnostics |
| Hub address, profile identifiers, process ID, and command lines are primary content | Setup appears harder than it is | Use sensible defaults; expose overrides under Advanced |
| “Running” means the Python child exists | A user may mistake startup or scanning for a drive-ready vehicle | Require live-session telemetry before presenting drive readiness |
| Hardware-ready progress precedes calibration | A connected device is not necessarily ready to accept input | Show preparation until the live runtime starts |
| Reconnect progress can coexist with old telemetry | A stale cockpit can imply that driving is still available | Clear live presentation on new setup/reconnect events |
| Fullscreen configuration is always visible | An occasional preference takes permanent space | Move it into Settings |
| Backend messages contain profile lists, IDs, and protocol language | Errors do not clearly suggest recovery | Translate known conditions into a short cause and next action; retain original details in Diagnostics |
| One large renderer component owns all state and markup | State changes and styling are difficult to reason about | Separate session presentation, small UI primitives, and screen composition |

The renderer must continue to work when profiles cannot load, Bluetooth is disabled, no controller
is available, the vehicle is off, a required port is missing, a diagnostic operation fails, or the
connection drops. A fresh source checkout is not the same thing as a self-contained consumer
installer. At the time of this audit Electron required an external Python checkout; the subsequent
[release pipeline work](release-pipeline.md) bundles and verifies a native engine in every package.

## Information architecture

**Drive** is the home screen. It contains the selected vehicle, one prominent Connect vehicle
action, controller guidance, and the current session state. The vehicle illustration is original
geometric artwork, not a photograph or a reproduction of a branded model. During connection, the
main card gives the next useful instruction. During driving, it exposes session status and a
prominent stop control. Controller actions are explained in a secondary guide.

**Settings** is a dialog for controller selection and fullscreen preference. The vehicle card
offers model selection when more than one profile is available. Advanced settings disclose the
hub-name and exact-address overrides. Changes to connection settings apply to the next session
and are disabled while an operation is active.

**Diagnostics** requires an explicit choice. It retains hub scanning, device reports, the input
probe, audio outputs, runtime information, raw telemetry, protocol events, and logs. Technical
details are intentionally useful here. Starting a diagnostic operation while another operation
runs is prevented, and the running operation always has an accessible stop action.

## Journey and state contract

| State | Primary message or next step | Behavior |
| --- | --- | --- |
| App loading | Getting things ready | Wait for the desktop bridge and catalog; never display fake device readiness |
| First launch / disconnected | Connect vehicle | Controller is selected automatically by default; model defaults come from Python |
| Waiting for Bluetooth | Turn on Bluetooth | Tell the user to enable it in system settings; retain Stop/Cancel |
| Waiting for controller | Connect your controller | Suggest pairing or USB; use general labels for automatic detection |
| Waiting for vehicle | Press the hub button | Explain the blinking/discoverable state without exposing an address |
| Reading the vehicle | Getting your vehicle ready | Initial discovery may generate the port map automatically |
| Preparing live control | Preparing your vehicle | Calibration/hardware progress alone does not prove readiness |
| Live runtime started | Ready to drive | The first live car telemetry is the readiness signal; input may move the model immediately |
| Impact lockout | Controls paused briefly | Use crash telemetry to explain temporary control blocking; do not report a disconnected device |
| Reconnecting | Reconnect controller / vehicle | Remove stale driving state; release controls because the backend resumes automatically after reconnection |
| Unsupported hub configuration | Check the connected vehicle | Expected model components are missing; suggest matching the model and refreshing discovery |
| Bluetooth permission issue | Allow Bluetooth access | Suggest the platform permission settings; keep raw exception details in Diagnostics |
| Other operation failure | Could not complete the action | Provide Retry when safe, Settings when relevant, and access to details |
| Stopping | Ending the session | Disable duplicate requests; await the process ending |
| Session ended | Connect again | Do not infer confirmed motor state from a terminated process alone |

Process status and hardware status are separate. In particular, `running` is also emitted when
the subprocess spawns; `setup/progress` can describe a scan or probe; and `gamepadProbe` telemetry
does not describe a live vehicle. The UI must consider the operation and data kind together.
Success for a diagnostic command comes from its `command/result`, not merely an exit event.

The Python engine owns motor-stop attempts, impact lockout, reconnect attempts, and calibration.
The desktop requests interruption and waits for completion. Window close and app quit must not
leave a live bridge running without an accessible control surface. Hardware behavior still needs
testing with a real controller and vehicle; a mock or a passing renderer test cannot verify it.

## Design language

The design combines a warm off-white canvas, graphite vehicle card, white control surfaces,
restrained orange action color, and original mechanical geometry. Large quiet areas and one
dominant vehicle card give the interface a consumer-hardware character. Decorative metric grids
and permanently visible console data are kept out of Drive.

The renderer stylesheet is the source of truth for design tokens. Use a small shared type scale,
an evenly stepped spacing scale, consistent control/card/dialog radii, three surface levels, and
restrained shadows. Use system fonts, locally defined SVG iconography, and tabular figures only
for values that benefit from alignment. Buttons have distinct primary, secondary, quiet, and
destructive treatments. Status indicators pair text with an icon/shape rather than relying on color.

Interactions need visible hover, press, keyboard focus, disabled, and busy states. Prefer native
buttons, labeled controls, semantic headings, and a modal dialog with focus containment and focus
restoration. Pointer targets should generally be at least 44 px. Transitions should be short and
functional; respect `prefers-reduced-motion`. Tooltips supplement accessible names, never replace
them. Connection animation must communicate waiting without implying measured progress.

## Controller guide: verified source mappings

These labels follow `config/gamepads/*.json` and the shipped model runtime. The UI must not invent
an on-screen throttle, battery estimate, measured speed, or control remapping that the engine does
not support.

| Action | DualSense | Steam Deck / generic SDL |
| --- | --- | --- |
| Steer | Left stick | Left stick |
| Forward / reverse | R2 / L2 | RT / LT |
| Brake while held | L1 | LB |
| Boost | R1 | RB |
| Change power mode (25%, 50%, 100%) | D-pad up / down | D-pad up / down |
| Toggle lights while stopped | Square | X |
| One-second light flicker | Circle | B |
| End session | Options | Menu / Start |

With automatic detection selected, combined labels avoid claiming a particular physical controller.
The boost lasts 1.95 seconds with a 7.5-second cooldown. Forward/reverse motion overrides manual
lights. Displayed drive power represents a command, not physical vehicle speed. Escape in the
terminal is implemented by Python; an Electron Escape shortcut requires its own renderer handler
because the subprocess does not receive keyboard stdin.

## Asset and naming inventory

The initial repository contains two SVG app marks made from rectangles, circles, and paths:
`assets/lego-technic-gamepad-bridge.svg` and
`ui/electron/src/renderer/src/assets/app-mark.svg`. Inspection found no official LEGO wordmark,
bundled branded font, raster product illustration, or remote artwork import in the renderer.
This describes inspected files and does not establish their provenance or licensing.

The project name and supported-hardware descriptions contain LEGO, Technic, Batmobile, DualSense,
and Steam Deck names. Keep these descriptive and distinguish the independent app from the hardware
brands. The repository includes `beep.mp3` without a visible source/attribution record; its origin
should be recorded before distributing it as a commercial asset. The root license is Apache-2.0,
while the initial Electron package metadata said MIT. The release pipeline now aligns that metadata
and the bundled license with the root Apache-2.0 license. A README independence notice does not resolve asset provenance.

## Validation

The baseline Python run on 2026-09-29 passed all 92 tests and `ruff check .`. Strict mypy identified
six existing typing failures: five uses of `ProtocolSetupConsole` where `SetupConsole` was expected,
and a non-explicit export of `profile_catalog_json`. These establish the starting point, not a
waiver for final checks.

The narrow backend fixes pass all 92 Python tests, Ruff, and strict mypy across 35 source files.
The JSONL setup console implements the existing setup-console contract by inheritance, and the
CLI explicitly exports its compatibility surface. Window close and app quit share a pending
bridge shutdown; four main-process regression checks cover an idle close, duplicate close,
concurrent close/quit, and failure/retry without destroying the control window early.

On 2026-09-30, renderer type checking and all 25 `npm test` checks passed after the component
extraction. These cover connection-state presentation, diagnostic access when profiles cannot
load, and main-process window/quit lifecycle. The actual Electron app also started, loaded Python
profiles through its real preload/main process, and reported no renderer console errors. Settings,
Controls, and Diagnostics are separate components; their shared controller type comes from the
hook's return type. Live impact telemetry now presents a temporary control pause while retaining
connected hardware and the stop action.

Final verification completed on 2026-09-30:

- 92 Python tests, Ruff, and strict mypy across 35 source files passed.
- 25 desktop state/service/lifecycle regression tests and TypeScript checking passed.
- 16 isolated Electron interaction checks passed with zero renderer console/runtime errors.
  Coverage includes connection and calibration gating, impact pause, reconnection, stop, all four
  diagnostic commands, profile/bootstrap recovery, stop access during delayed or failed startup,
  preference rollback, keyboard focus and Escape, reduced motion, 760×600 layout, and 200% zoom.
- 19 UI screenshots were captured; primary, connected, recovery, dialog, and diagnostic layouts
  were visually reviewed. The minimum-size primary action remains inside the viewport.
- `npm run dist:mac` produced unsigned Apple Silicon DMG and ZIP packages under `ui/electron/release`.
  The packaged Axle 0.1.0 app itself launched successfully, loaded the real Python catalog, and
  reported no renderer errors or horizontal overflow. Its preferences were isolated for testing.
- The installer uses an original beam mark rendered from the local SVG; its macOS icon and Axle
  display name were verified in package metadata. The established preferences location is retained.

UI fixture APIs exist only in the test runner's temporary preload. They do not launch the hardware
backend or modify saved user preferences. Actual main-process and packaged-app startup checks used
the existing Python environment for catalog loading only. Physical Bluetooth, controller input,
calibration, and motor behavior have **not** been tested with a connected vehicle. The package
at that stage still required an external Python environment/source checkout. The subsequent
release pipeline replaces that dependency with a bundled native runtime.

The repository has no frontend lint script or browser-test dependency at the audit starting point.
The release pipeline now adds pinned development dependencies for linting and Playwright, with
portable UI and packaged-app smoke tests. See [release pipeline details](release-pipeline.md).
