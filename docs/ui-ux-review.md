# Axle UI/UX review — 3 October 2026

## Assessment

Original: **7.5/10**. Axle already had a clear hierarchy, a coherent visual language,
an engaging vehicle preview, automatic connection and recovery, and useful separation
between driving and diagnostics. The main weaknesses were behavioral: Stop could restart
automatically, expired or other-model feedback could still imply readiness, connection
editing could interrupt setup while typing, and some guidance described an obsolete workflow.

Result: **8.5/10** for the reviewed desktop experience. The improvements make state and
recovery more trustworthy without replacing the established design. Physical vehicle
validation and native testing on other platforms remain necessary before a public launch.

## Product and architecture

The primary journey is launch → connect controller and Tumbler automatically → steering
setup → fresh live feedback → drive with the controller → recover from device loss.
Settings contains occasional preferences and connection overrides. Developer mode adds
device checks, results, event history, logs and runtime details.

React owns presentation and session coordination, the sandboxed preload exposes typed
IPC, Electron owns worker lifecycle and desktop integration, and Python owns Bluetooth,
controller input, calibration, motor control and safety. No second hardware-control
implementation, dependencies, assets or remote services were introduced.

## Kept

- Automatic startup, unexpected-worker retry, calibration gating and device recovery.
- The warm canvas, dark vehicle preview, restrained orange, system typography, spacing
  scale, original iconography and existing card hierarchy.
- Interactive 3D, contextual camera views, measured wheel movement and optional street.
- Native dialogs, labelled controls, Escape, focus restoration and reduced motion.
- Useful technical telemetry and tools behind Developer mode.

## Changes

| Priority | Previous problem | Result and rationale |
| --- | --- | --- |
| P1 | A deliberate Stop on Drive could reconnect on the next retry tick | Stop pauses automatic connection until Resume. Failed Stop remains actionable. Startup and unexpected-exit retry remain automatic; Diagnostics retains its separate stop/check flow. |
| P1 | Ready could remain visible after vehicle feedback expired; another model could also satisfy readiness | Ready requires fresh feedback from the selected vehicle. Expiration shows Checking your connection, and a fresh matching frame restores readiness without another worker. |
| P1 | A typing pause in advanced settings could restart the session | Name/address remain drafts until Apply changes or Enter commits them together. Unapplied drafts are discarded when Settings closes. |
| P2 | Resuming immediately after editing preferences could briefly start with old values | Resume configures the latest preferences before enabling the automatic session, avoiding a redundant setup cycle. |
| P2 | The guide referred to a missing Connect vehicle action and misrepresented the controller exit action | Guidance describes automatic setup, wheels-clear preparation, Drive power and Restart connection. Dialog titles are Settings and How to drive. |
| P2 | Stop failures could appear only behind the open guide; native window close/quit failures could be silent | The guide displays stop errors, and native cleanup failures explain why Axle stayed open and how to retry. Concurrent native failures share one notice. |
| P2 | A 760px window at 200% zoom clipped the header | Compact layouts retain header actions; Developer navigation moves onto its own row. Dialogs and diagnostics remain keyboard reachable without horizontal overflow. |
| P2 | Some secondary text, dark-menu focus and control boundaries had inadequate contrast | Semantic colors now meet the relevant text/control thresholds, including hover states. |
| P2 | Clearing Events also erased command Results | Clearing event history preserves diagnostic results. |
| P3 | A lone Drive tab, single-option vehicle selector and preview implementation badge added little useful information | Navigation appears when Diagnostics is enabled, Settings shows the one supported vehicle as text, and View remains the preview's interaction entry point. |

## Accessibility and design system

Muted text is **5.03:1** against the canvas and **4.70:1** against the guide surface.
Input borders are **3.52:1** against white, and camera-menu focus is **9.51:1** against
its dark panel. Shared control-border and focus tokens replace inconsistent values;
the existing type and spacing scales remain intact. Native form submission supports
Enter, status/errors are announced, and navigation from Settings to Diagnostics focuses
the main content. No redundant ARIA or custom modal implementation was added.

## Important files

- [App.tsx](../ui/electron/src/renderer/src/App.tsx): navigation, paused state, Resume,
  contextual recovery and focus handoff.
- [SettingsDialog.tsx](../ui/electron/src/renderer/src/components/SettingsDialog.tsx)
  and [ControlsDialog.tsx](../ui/electron/src/renderer/src/components/ControlsDialog.tsx):
  staged connection edits, clearer guidance and stop feedback.
- [useBridgeController.ts](../ui/electron/src/renderer/src/hooks/useBridgeController.ts),
  [session.ts](../ui/electron/src/renderer/src/lib/session.ts) and
  [automaticSession.ts](../ui/electron/src/renderer/src/lib/automaticSession.ts): readiness,
  durable pause, safe resume, context-specific errors and retained results.
- [styles.css](../ui/electron/src/renderer/src/styles.css): contrast tokens and compact layouts.
- [main/index.ts](../ui/electron/src/main/index.ts): native shutdown recovery notice.
- [smoke-test.cjs](../ui/electron/scripts/smoke-test.cjs) and session, automatic-session
  and window-lifecycle tests: behavior regressions and rendered-state evidence.
- [Desktop README](../ui/electron/README.md): current connection, pause and settings behavior.

## Verification

- Before changes: production build and all **22** existing isolated Electron checks passed.
- Frontend unit/service/lifecycle tests: **244 passed**.
- TypeScript, frontend lint and production main/preload/renderer build: passed.
- Expanded isolated Electron suite: **29 checks passed**, with no unexpected renderer
  console/runtime errors. Coverage includes automatic startup, readiness, Bluetooth off,
  preparation, impact pause, controller loss, unexpected exits, staged settings, deliberate
  Stop/Resume, immediate resume with edited settings, failed-stop retry, fullscreen rollback,
  bootstrap/profile recovery, all four diagnostic commands, retained results, camera
  keyboard/touch controls, 760×600 windows, 200% zoom, stale feedback, reduced motion and
  graphics-context loss.
- Rendered screenshots were inspected for the primary screen, connection/recovery states,
  dialogs, advanced settings, camera menu, diagnostics and compact layouts.
- Python: **453 passed, 1 failed**. Ruff, formatting (**86 files**) and strict mypy
  (**41 files**) passed. No Python files changed.
- macOS arm64 app packaging passed using the installed Electron distribution after the
  default attempt could not reach GitHub. This checks the app directory, not new DMG/ZIP
  installers or other platform packages.
- Packaged-app smoke check passed: the real macOS app launched with its real preload,
  loaded the catalog from the bundled native runtime, and verified package resources,
  notices and signatures. Preferences were isolated and hardware/update checks disabled.
- Native compositor captures confirmed the paused 3D preview and 200% zoom layout;
  browser screenshot capture alone was unreliable for native zoom and idle WebGL.

## Remaining issues and limits

- [The existing wheel-feedback shutdown test](../tests/test_wheel_feedback.py) fails on
  the available Python 3.12 runtime: an immediately completed request permits a second
  port read before queued close executes. It reproduces independently of these UI changes.
  Resolving the backend scheduling/test contract deserves separate investigation rather
  than an unreviewed motor-lifecycle change during a UI audit.
- Physical Bluetooth pairing, calibration, controller input and motor shutdown were not
  verified with a connected vehicle. Fixtures cannot establish those hardware properties.
- Native Windows/Linux/Steam Deck launch and packaging were not run on this macOS host.
  Their shared renderer and platform-independent lifecycle behavior were covered locally.
