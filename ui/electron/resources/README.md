# Packaging resources

`icon.png` is the original Axle app mark, rendered at 1024×1024 from
`src/renderer/src/assets/app-mark.svg`. Electron Builder converts it for each desktop target.
The mechanical beam symbol is independent artwork; it does not use a hardware brand's logo.

The packaged app is named **Axle**. The main process retains the established internal app name
for `userData` lookup so existing desktop preferences remain available after the visual redesign.

The build hook stages the host-native frozen bridge under `bridge/`, which is ignored by Git.
Electron Builder copies it to `resources/bridge` outside the ASAR archive. Build the native engine
first with `python scripts/build_release.py` from the repository root. Installed applications
run this bundled engine and keep writable files in the existing `userData` directory.
