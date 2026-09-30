export type BuildTargetId = "macos" | "windows" | "linux" | "steamdeck";

export type BuildTarget = {
  id: BuildTargetId;
  label: string;
  artifact: string;
  command: string;
  host: string;
};

export type RuntimeItem = {
  label: string;
  value: string;
  state: "ready" | "planned" | "external";
};

export type BootstrapState = {
  appName: string;
  appVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  electronVersion: string;
  chromiumVersion: string;
  nodeVersion: string;
  buildTargets: BuildTarget[];
  runtimeItems: RuntimeItem[];
};

export const buildTargets: BuildTarget[] = [
  {
    id: "macos",
    label: "macOS",
    artifact: "DMG + ZIP",
    command: "npm run dist:mac",
    host: "macOS"
  },
  {
    id: "windows",
    label: "Windows",
    artifact: "NSIS installer",
    command: "npm run dist:win",
    host: "Windows"
  },
  {
    id: "linux",
    label: "Linux",
    artifact: "AppImage + deb",
    command: "npm run dist:linux",
    host: "Linux x64"
  },
  {
    id: "steamdeck",
    label: "Steam Deck",
    artifact: "AppImage x64",
    command: "npm run dist:steamdeck",
    host: "Linux x64"
  }
];

export const runtimeItems: RuntimeItem[] = [
  {
    label: "Renderer",
    value: "React + Vite",
    state: "ready"
  },
  {
    label: "Process Boundary",
    value: "Context-isolated preload IPC",
    state: "ready"
  },
  {
    label: "Bridge Runtime",
    value: "Main-process Python orchestration",
    state: "ready"
  },
  {
    label: "Controls",
    value: "Live control, hub scan, diagnostics",
    state: "ready"
  }
];
