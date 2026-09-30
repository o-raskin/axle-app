import { app, BrowserWindow, ipcMain, Menu, type MenuItemConstructorOptions, shell } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { BridgeProcessService } from "./bridgeProcessService";
import {
  bridgeIpcChannels,
  type BridgeLogEvent,
  type BridgeProcessSnapshot,
  type BridgeProtocolEvent
} from "../shared/bridge";
import { buildTargets, type BootstrapState, runtimeItems } from "../shared/bootstrap";
import { defaultDesktopSettings, type DesktopSettings, type DesktopSettingsPatch } from "../shared/settings";

const appDisplayName = "LEGO Technic Gamepad Bridge";
const rendererDevUrl = process.env.ELECTRON_RENDERER_URL;
let mainWindow: BrowserWindow | null = null;
let appQuitAfterBridgeStop = false;
let appQuitPending = false;
let pendingBridgeShutdown: Promise<void> | null = null;

app.setName(appDisplayName);

const bridgeService = new BridgeProcessService({
  publishLog: (event: BridgeLogEvent) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(bridgeIpcChannels.log, event);
    }
  },
  publishStatus: (snapshot: BridgeProcessSnapshot) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(bridgeIpcChannels.status, snapshot);
    }
  },
  publishEvent: (event: BridgeProtocolEvent) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(bridgeIpcChannels.event, event);
    }
  }
});

function getSettingsPath(): string {
  return join(app.getPath("userData"), "desktop-settings.json");
}

function normalizeSettings(value: unknown): DesktopSettings {
  if (!value || typeof value !== "object") {
    return defaultDesktopSettings;
  }

  const candidate = value as Partial<DesktopSettings>;

  return {
    launchFullscreen:
      typeof candidate.launchFullscreen === "boolean"
        ? candidate.launchFullscreen
        : defaultDesktopSettings.launchFullscreen
  };
}

function readDesktopSettings(): DesktopSettings {
  try {
    return normalizeSettings(JSON.parse(readFileSync(getSettingsPath(), "utf8")));
  } catch {
    return defaultDesktopSettings;
  }
}

function writeDesktopSettings(settings: DesktopSettings): void {
  const settingsPath = getSettingsPath();

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function updateDesktopSettings(patch: DesktopSettingsPatch): DesktopSettings {
  const currentSettings = readDesktopSettings();
  const nextSettings = normalizeSettings({
    ...currentSettings,
    ...patch
  });

  writeDesktopSettings(nextSettings);
  return nextSettings;
}

function getBootstrapState(): BootstrapState {
  return {
    appName: "Axle",
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron,
    chromiumVersion: process.versions.chrome,
    nodeVersion: process.versions.node,
    buildTargets,
    runtimeItems
  };
}

function installApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? [
          {
            label: "Axle",
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const }
            ]
          }
        ]
      : []),
    {
      label: "File",
      submenu: [process.platform === "darwin" ? { role: "close" } : { role: "quit" }]
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      ]
    },
    {
      label: "View",
      submenu: [
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { type: "separator" },
        {
          label: "Developer",
          submenu: [{ role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }]
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpcHandlers(): void {
  ipcMain.handle("bootstrap:get-state", () => getBootstrapState());
  ipcMain.handle("settings:get", () => readDesktopSettings());
  ipcMain.handle("settings:update", (_event, patch: DesktopSettingsPatch) => {
    const nextSettings = updateDesktopSettings(patch);

    if (mainWindow) {
      mainWindow.setFullScreen(nextSettings.launchFullscreen);
    }

    return nextSettings;
  });
  ipcMain.handle(bridgeIpcChannels.getProfiles, () => bridgeService.getProfiles());
  ipcMain.handle(bridgeIpcChannels.getStatus, () => bridgeService.getStatus());
  ipcMain.handle(bridgeIpcChannels.startLive, (_event, options: unknown) => bridgeService.startLive(options));
  ipcMain.handle(bridgeIpcChannels.stop, () => bridgeService.stopActiveProcess());
  ipcMain.handle(bridgeIpcChannels.runCommand, (_event, request: unknown) => bridgeService.runCommand(request));
}

function stopBridgeBeforeClosing(): Promise<void> {
  if (!pendingBridgeShutdown) {
    pendingBridgeShutdown = bridgeService.stopForAppQuit().finally(() => {
      pendingBridgeShutdown = null;
    });
  }
  return pendingBridgeShutdown;
}

function createMainWindow(): void {
  const settings = readDesktopSettings();

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 760,
    minHeight: 600,
    fullscreen: settings.launchFullscreen,
    title: "Axle — Technic Gamepad Bridge",
    backgroundColor: "#f4f3ef",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const window = mainWindow;
  let closePending = false;
  let closeAfterBridgeStop = false;

  window.on("close", (event) => {
    if (closeAfterBridgeStop || !bridgeService.hasActiveProcess()) {
      return;
    }

    event.preventDefault();
    if (closePending) {
      return;
    }
    closePending = true;
    void stopBridgeBeforeClosing().then(() => {
      closeAfterBridgeStop = true;
      if (!window.isDestroyed()) {
        window.close();
      }
    }).catch((error: unknown) => {
      closePending = false;
      console.error("Could not stop the bridge before closing the window", error);
    });
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (rendererDevUrl) {
    void mainWindow.loadURL(rendererDevUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.on("web-contents-created", (_event, contents) => {
  contents.on("will-navigate", (event, url) => {
    const isDevRenderer = rendererDevUrl && url.startsWith(rendererDevUrl);
    const isPackagedRenderer = url.startsWith("file://");

    if (!isDevRenderer && !isPackagedRenderer) {
      event.preventDefault();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (appQuitAfterBridgeStop || !bridgeService.hasActiveProcess()) {
    return;
  }

  event.preventDefault();
  if (appQuitPending) {
    return;
  }
  appQuitPending = true;
  void stopBridgeBeforeClosing().then(() => {
    appQuitAfterBridgeStop = true;
    app.quit();
  }).catch((error: unknown) => {
    appQuitPending = false;
    console.error("Could not stop the bridge before quitting", error);
  });
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

void app.whenReady().then(() => {
  registerIpcHandlers();
  installApplicationMenu();
  createMainWindow();
});
