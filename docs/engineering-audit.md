# Engineering audit — 2026-10-02

The audit inspected the Python runtime, BLE/PLAYVM boundaries, controller discovery and input,
feedback, configuration and persistence, CLI/JSONL entry points, Electron main/preload/renderer,
3D model lifecycle, update handling, build/release tooling, existing tests, and CI. The changes
are targeted fixes with regression protection. Existing user changes were preserved.

## Architecture and safety invariants

The Python process owns BLE, SDL/controller handles, model rules, and motor shutdown. A model
profile and saved physical port map feed the Tumbler runtime; its frames pass through the
PLAYVM control layer and serialized BLE transport. Feedback consumes the same runtime state.
The CLI and JSONL frontend share this engine. Electron owns child-process lifetime, validated
settings, IPC, and updates. Its restricted preload exposes typed operations to the React UI.
The renderer projects telemetry into session and vehicle state and owns the Three.js viewer.
The release scripts freeze the Python engine, package it with Electron, and verify artifacts
before publication.

Regression tests enforce these invariants:

- An old connection's callback or queued command cannot mutate or drive a replacement hub.
- Invalid controller values and malformed protocol frames cannot produce unsafe commands.
- A worker remains owned until close; a failed Stop cannot pretend that the worker exited.
- Cancellation and optional feedback failures cannot bypass bounded motor-stop/disconnect cleanup.
- Crash lockout wins over simultaneous speed, boost, light, and flicker inputs.
- Only the owned main renderer frame can invoke IPC, and navigation retains that trust boundary.
- Failed persistence or artifact operations preserve the previous valid file.
- Disposed viewer resources and late model loads do not survive the viewer's lifetime.

## Tests

New tests cover normalization and profile validation, BLE lifecycle and parser truncations,
startup/reconnect/shutdown, integrated drive feedback, CLI dispatch and JSONL errors, fragmented
keyboard sequences, audio process/output ownership, wheel-feedback startup and metadata,
release integrity, child-process races, IPC/navigation trust, preload subscriptions, settings,
updates, retry pacing, model resource ownership, and stale wheel telemetry.

The integration layer uses real runtime, feedback, PLAYVM, and transport components behind a
simulated hub; actual scan-to-report/physical-port-map persistence; controller inventory/probe
workflows behind SDL fakes; a real child process for JSONL Stop; and compiled
main/preload code behind an Electron boundary fake. UI and packaged-app checks launch actual
Electron with isolated data directories and hardware discovery disabled. GitHub publication
tests simulate the external command boundary and do not publish releases.

Existing frontend-stop and discovery tests now synchronize on actual events and cleanup
barriers instead of arbitrary polling sleeps. The camera UI check now observes consecutive
completed render frames instead of comparing potentially skipped animation samples; all original
movement, clearance, and floor thresholds remain in place, and frame samples are saved on failure.
Controller/platform fakes model the lifecycle checks now made by production code.
Parameterized tests exercise invalid profiles, every
truncated frame prefix, initialization failures, and CLI error/exit contracts.

Coverage uses pytest-cov with branch measurement and c8 with source maps. VM test scripts retain
their generated source until reporting, and source-map paths are normalized before remapping;
this avoids both missing coverage and falsely marking unexecuted bundled methods covered.
The reports include all Python bridge/release modules and all desktop source/scripts. Only
TypeScript declaration files are omitted from desktop coverage. CI runs both coverage suites
and retains their reports; it does not impose an arbitrary percentage threshold.

The final Python suite has **420 passing cases**, up from the observed 138-case baseline.
The desktop suite has **166 passing tests**, with no failures, cancellations, or skips.
The Electron UI suite has 19 behavioral checkpoints; three normal runs and a run with 4× renderer
CPU throttling passed all checkpoints.

| Coverage scope | Lines/statements | Branches |
| --- | ---: | ---: |
| Python bridge and release scripts | 80.42% | 72.44% |
| Python Tumbler runtime | 99.44% | 94.44% |
| Python PLAYVM control | 99.25% | 97.73% |
| Python wheel feedback | 98.81% | 94.29% |
| Python profile validation | 100% | 100% |
| Python BLE transport | 91.73% | 80.85% |
| Python JSONL protocol | 85.87% | 80.77% |
| Python session orchestration | 60.13% | 55.74% |
| Python hub scanning | 97.50% | 78.57% |
| Python controller input/discovery/diagnostics | 80.35% | 71.88% |
| Python port-map handling | 95.40% | 97.37% |
| Desktop all source and scripts, Node measurement | 38.94% | 83.49% |
| Desktop child-process service | 84.29% | 76.80% |
| Desktop main entry point | 84.59% | 77.96% |
| Desktop preload, renderer trust, and settings persistence | 100% | 100% |
| Desktop renderer vehicle-state rules | 100% | 100% |

Python's combined statement-and-branch result is **78.56%**. The desktop percentage excludes
execution by the separate Electron UI/package checks, while retaining those files in the
denominator. The Node total also includes type-only `.ts` files; it should not be read as
83.49% coverage of all possible unexecuted UI branches. See the gap explanations below.

## Bugs fixed and regression protection

| Problem and root cause | Fix | Regression protection |
| --- | --- | --- |
| Non-finite axis/trigger values could pass through normalization and become motor power; invalid indices reached SDL. | Neutralize NaN/infinity and reject invalid reads. | `test_gamepad_input.py` |
| Discovery ignored exclusions and lost handles when a candidate vanished or initialization failed. | Apply exclusions consistently, isolate candidate failures, and release rejected/partial handles. | `test_gamepad_input.py` |
| Profile identifiers could escape their directory; malformed JSON fields could silently coerce, wrap command bytes, or accept non-finite/negative timing and invalid power limits. | Centralize finite numeric, identifier, mapping, range, and byte validation with actionable errors. | `test_profiles.py` |
| Port maps accepted malformed roots, out-of-range ports, duplicate motor roles, and wrong attached device types; direct writes could destroy the old map. | Validate persisted maps and required ports; use flushed atomic replacement. | `test_port_map_validation.py` |
| Scanning a previously paired hub inferred physical drive roles from lower-numbered virtual motor attachments. | Exclude virtual attachments from physical wiring roles while retaining them in the probe report. | `test_hub_probe_workflow.py` |
| One disappearing joystick aborted controller inventory, and initial human-probe metadata/snapshot failures leaked SDL. | Isolate diagnostic failures per candidate, close every opened handle, and establish probe cleanup before initialization. | `test_gamepad_diagnostics_workflow.py` |
| Partially failed BLE connect leaked a client; reconnect kept stale topology and accepted previous-client callbacks. | Own the connecting client, clean failure/cancellation, clear caches, and guard callbacks by client identity. | `test_transport_boundaries.py` |
| A command queued behind the write lock could cross disconnect/reconnect and reach a new hub. | Capture the intended client before waiting and reject changed/disconnected ownership under the lock. | `test_transport_boundaries.py` |
| Advertising local names could hide a valid device name. | Match either name while preserving an explicit address override. | `test_transport_boundaries.py` |
| Truncated or inconsistent BLE messages polluted queues/caches; detached ports retained metadata and encoder values. | Validate frame headers and message lengths before mutation; invalidate all detached-port caches. | `test_transport_boundaries.py` |
| PLAYVM startup could accept another virtual pair, another register's notification, or incomplete calibration status. | Match the requested physical pair and register and require complete frames. Fatal-status regression cases also protect the existing rejection contract. | `test_tumbler_control.py`, existing byte-level startup tests |
| Speed changes and buttons ran before impact evaluation, producing false crashes or same-frame actions during a real crash. | Evaluate impact against prior drive state before applying inputs and give lockout precedence. | `test_tumbler_runtime.py` |
| Boost-tail rumble overwrote unavailable-boost/speed pulses, and telemetry described suppressed rumble. | Honor pulse pause windows across all drive-rumble branches and report the active pulse. | `test_session_feedback.py`, `test_tumbler_runtime.py` |
| Repeated wheel startup created duplicate unowned readers; real BLE errors, invalid metadata, and unstable polarity samples broke optional feedback. | Make startup idempotent, classify actual Bleak errors, validate metadata, and bound polarity evidence. | `test_wheel_startup.py`, `test_wheel_feedback.py` |
| Motor cleanup could be skipped by initialization/feedback failures, logger errors, repeated cancellation, or stalled BLE calls. | Move ownership into cleanup scope; isolate each cleanup step; shield shutdown and bound stop/disconnect operations. | `test_session_lifecycle.py` |
| Optional wheel/rumble/audio/console cleanup failures were invisible, obscuring resource failures during safe shutdown. | Report each failure without allowing diagnostics to interrupt subsequent cleanup. | `test_session_lifecycle.py` |
| Hardware readiness accepted a controller lost while waiting for the hub; BLE write errors could enter the controller reconnect path. | Poll real controller readiness again before handoff and classify BLE failures explicitly. | `test_session_lifecycle.py` |
| Probe initialization/emission failures leaked SDL; streaming logs grew without bound. | Establish cleanup before metadata/snapshot/emission and cap retained dashboard logs while streaming all events. | `test_protocol_lifecycle.py` |
| Conflicting CLI operations silently selected one action; repeated frontend options used a different interrupt format from argparse. | Make operations mutually exclusive and follow the last parsed frontend value. | `test_cli_workflows.py` |
| Fragmented arrow sequences looked like Escape; repeated terminal open lost the original terminal settings. | Buffer bounded escape/extended-key prefixes and make terminal acquisition idempotent. | `test_keyboard_lifecycle.py` |
| Audio launch/termination/waiter failures left the output changed; an old waiter could affect a newer beep or overwrite the user's output choice. | Bind waiters to their process, restore only owned output changes, and unwind every launch/stop failure. | `test_audio_lifecycle.py` |
| IPC trusted a window without validating its main frame/document; arbitrary file navigation and unsafe external schemes widened privileges. | Require owned frame and exact trusted document; block redirects/webviews and restrict external URL schemes. | `desktop-boundaries.test.ts`, `window-lifecycle.test.cjs` |
| Child ownership was dropped on error/exit before close, allowing another worker and stale callbacks. | Retain ownership until close, guard callbacks, coalesce catalog workers, and track them through quit. | `bridge-process.test.ts`, `bridge-stop.test.cjs` |
| An OS error or stale asynchronous validation failure marked an owned active worker inactive, hiding Stop. | Preserve active status/PID while reporting the error until that worker closes. | `bridge-process.test.ts` |
| Stop timeout falsely confirmed shutdown; malformed/timed-out profile workers survived; session identifiers could repeat. | Keep failed-stop ownership for retry, terminate failed catalog workers, validate results, and use unique session IDs. | `bridge-process.test.ts`, `window-lifecycle.test.cjs` |
| Interpreter probing accepted a successful non-Python command, Python 2, or a Python version below the documented minimum. | Require Python 3.9+ before source startup, including versions printed on stderr. | `bridge-process.test.ts` |
| Settings updates accepted invalid values and could truncate persisted preferences. | Extract validated updates and atomic persistence. | `desktop-boundaries.test.ts` |
| Driving could start while an update confirmation was open; manual installation could use an incompatible platform path. | Recheck active driving after consent and enforce installation capability. | `updates.test.ts` |
| Slow automatic-start failures could retry immediately because pacing began before the failed operation. | Start failure backoff when the attempt finishes. | `automatic-session.test.ts` |
| Stale wheel samples expired newer telemetry; model binding accepted unusable geometry; shared GPU resources were disposed repeatedly. | Reject out-of-order samples before expiry, validate geometry/radius, and dispose unique resources. | `wheel-motion.test.ts`, `tumbler-lifecycle.test.ts` |
| Viewer context loss/load failure left resources active; a late loader callback could leak its model after teardown. | Make cleanup immediate and idempotent and dispose late models. | `tumbler-lifecycle.test.ts`, real Electron context-loss UI check |
| Release verification/staging could follow output symlinks; malformed manifests failed unpredictably. | Reject symlink destinations, validate structure, and replace generated files atomically. | `test_release_assets.py`, `test_release_build.py` |
| Publication trusted remote asset names/sizes, allowing same-size corruption and unsafe retries. | Read back and hash every remote asset before publishing or accepting an idempotent retry. | `test_release_assets.py` |
| Frozen verification accepted invalid payload/default shapes and leaked temporary state after failures/timeouts; Windows names could be reserved. | Validate frozen commands/catalogs, always clean temporary state, and validate native executable names. | `test_release_verification.py`, `test_release_build.py` |
| Desktop packaging could copy a symlink or wrong OS/architecture binary and leave partial output. | Verify the regular native executable before atomic staging. | `bundle-bridge.test.cjs` |
| CAD source packing/extraction used colliding temporary names and accepted unsafe paths/records; failed writes risked the old archive. | Preflight all records, reject traversal, use unique temporary files, and atomically replace archives. | `tumbler-source-bundle.test.cjs` |
| Notice generation misidentified a symlinked checkout and accepted empty license text. | Resolve the checkout root and reject empty license evidence. | `software-notices.test.cjs` |
| The system Python 3.9 installer selected a macOS dependency with incorrect compatibility metadata, causing source installation to fail. | Upgrade pip in each virtual-environment setup recipe before installing the unchanged requirements. | Clean temporary Python 3.9 installation and the complete 420-case suite |

The macOS setup failure selected PyObjC 12.0; its maintainer withdrew that release because it
incorrectly advertised Python 3.9 support. The updated installer selected compatible PyObjC 11.1
wheels. [Maintainer's PyPI release metadata](https://pypi.org/project/pyobjc-core/12.0/).

## Architecture improvements

- Shared profile validation removes divergent coercion at configuration boundaries. Model and
  controller loaders retain their existing public entry points and file formats.
- Settings and renderer trust checks are small explicit modules so persistence and IPC policies
  can be exercised without starting the whole desktop application.
- BLE and process lifetimes now have explicit identity/ownership boundaries. Shutdown has one
  cancellation-safe owner, while the UI retains a retryable Stop until worker closure.
- Integrated fakes sit at the actual hardware/OS/process boundary, allowing production model,
  protocol, and feedback code to run together. The audit introduces no framework or UI styling
  changes; existing user interface edits are preserved.

## Security and reliability

The fixes strengthen renderer-to-main trust, external URL handling, profile/archive path
validation, filesystem writes, remote artifact integrity, bounded logs, and device/process
ownership. Real dependency exceptions and cancellation receive explicit handling. Optional
feedback is best effort so an audio/LED/rumble failure cannot prevent motor shutdown.

Invalid configuration and conflicting CLI actions now fail early rather than silently coercing
or choosing a command. Corrupt saved maps and profiles must be corrected or regenerated. These
are intentional compatibility changes for invalid inputs; valid shipped profiles, protocol
envelopes, IPC methods, and normal controls retain their contracts.

## Remaining risks and coverage interpretation

- Physical BLE discovery, radio loss timing, firmware-specific PLAYVM/calibration, actual motor
  direction/encoder polarity, and mechanical crash behavior need a hub and model. Fakes verify
  commands and state transitions, not physical motion. Keep the model raised for manual checks.
- Stop/disconnect timeouts depend on cooperative asyncio cancellation. Wheel-reader cleanup
  precedes motor shutdown, so the report does not claim a global cleanup deadline. Killing a
  worker confirms process closure, not physical motor stop after an unresponsive radio link.
- SDL device mappings/permissions, real controller hotplug/rumble/LED, and CoreAudio speaker
  routing need their actual devices and OS services. OS calls are isolated and tested through
  boundary fakes; the environment cannot certify real device behavior.
- Native Windows/Linux/Intel macOS installers, Steam Deck FUSE/Wayland, downloaded Gatekeeper
  quarantine, and signed/notarized update delivery require those platforms/infrastructure.
  The existing native CI matrix remains responsible for platform builds and launch checks.
- GitHub upload/readback failures are simulated. No live release was uploaded or published.
- Python session/menu/dashboard and OS adapters retain gaps for interactive and platform paths.
  The critical shutdown/reconnect failures have behavioral regressions, but the coverage result
  does not claim exhaustive startup/UI/OS combinations.
- Visual telemetry expires if the backend becomes silent, but connection readiness is based on
  reported process/progress state. There is no end-to-end heartbeat contract guaranteeing that
  a silent, still-running worker is healthy; changing that policy needs a defined timeout and
  reconnection contract.
- Desktop Node coverage retains zero-coverage React components, the renderer hook, native
  launcher scripts, and type-only `.ts` modules. Real Electron UI/package checks cover some of
  those paths separately; their execution is not included in the Node percentage. Unvisited
  platform update adapters also remain visible. Neither the low total line percentage nor the
  aggregate branch percentage alone describes end-to-end coverage.

## Verification

| Check | Result |
| --- | --- |
| `python -m pytest tests -q --cov` | 420 passed in 35.89 seconds; JSON/XML coverage generated |
| Minimum Python 3.9 runtime, clean temporary environment | Unchanged dependencies installed; all 420 tests passed with coverage in 36.46 seconds |
| `npm run test:coverage` | 166 passed; no failures, cancellations, or skips |
| Python Ruff lint and formatting | Passed; 82 files formatted |
| Python strict mypy with repository options | Passed; 41 source files |
| Electron lint with warnings denied | Passed |
| Electron TypeScript check and production build | Passed |
| GitHub workflow validation with actionlint | Passed |
| Whitespace/diff validation | Passed |
| Fresh native bridge build and isolated verification | Passed on macOS arm64 |
| Fresh ad-hoc-signed macOS desktop package | Passed signatures, bundled runtime/notices/catalog, preload IPC, and launch verification |
| Actual Electron UI | All 19 checkpoints passed in three normal runs and one run at 4× renderer CPU throttling, including the final current build |

Local validation uses Python 3.12, Python 3.9, and Node 25 on Apple Silicon macOS. The main coverage
table reports the Python 3.12 run. Node 24 and the other native platforms are covered by the
configured CI jobs; those remote jobs were not run in this audit.

The local native validation builds a fresh frozen bridge in a temporary output directory,
checks its isolated commands/resources, builds an ad-hoc-signed macOS application with that
bridge, and verifies signatures, packaged bytes/notices/catalog, preload IPC, and actual launch.
It does not overwrite existing release artifacts, upload a release, or change machine settings.

Build output was reviewed. PyInstaller's missing-import inventory contains conditional modules
for other platforms, optional dependencies, and dynamic PyObjC names; isolated frozen commands
and the packaged bridge passed. Electron-builder reports the ad-hoc hardened-runtime advisory
and skips notarization because no Apple credentials are configured. Local signature/launch
checks pass; downloaded Gatekeeper behavior and notarized distribution remain platform checks.
