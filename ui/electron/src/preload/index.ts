import { contextBridge, ipcRenderer } from "electron";

import {
  bridgeIpcChannels,
  type BridgeActionResult,
  type BridgeCommandRequest,
  type BridgeLogEvent,
  type BridgeProcessSnapshot,
  type BridgeProtocolEvent,
  type BridgeProfileCatalog,
  type BridgeStartOptions
} from "../shared/bridge";
import type { BootstrapState } from "../shared/bootstrap";
import type { DesktopSettings, DesktopSettingsPatch } from "../shared/settings";

const desktopApi = {
  getBootstrapState: (): Promise<BootstrapState> => ipcRenderer.invoke("bootstrap:get-state") as Promise<BootstrapState>,
  getSettings: (): Promise<DesktopSettings> => ipcRenderer.invoke("settings:get") as Promise<DesktopSettings>,
  updateSettings: (patch: DesktopSettingsPatch): Promise<DesktopSettings> =>
    ipcRenderer.invoke("settings:update", patch) as Promise<DesktopSettings>,
  getBridgeProfiles: (): Promise<BridgeProfileCatalog> =>
    ipcRenderer.invoke(bridgeIpcChannels.getProfiles) as Promise<BridgeProfileCatalog>,
  getBridgeStatus: (): Promise<BridgeProcessSnapshot> =>
    ipcRenderer.invoke(bridgeIpcChannels.getStatus) as Promise<BridgeProcessSnapshot>,
  startBridge: (options: BridgeStartOptions): Promise<BridgeActionResult> =>
    ipcRenderer.invoke(bridgeIpcChannels.startLive, options) as Promise<BridgeActionResult>,
  stopBridge: (): Promise<BridgeActionResult> =>
    ipcRenderer.invoke(bridgeIpcChannels.stop) as Promise<BridgeActionResult>,
  runBridgeCommand: (request: BridgeCommandRequest): Promise<BridgeActionResult> =>
    ipcRenderer.invoke(bridgeIpcChannels.runCommand, request) as Promise<BridgeActionResult>,
  onBridgeLog: (callback: (event: BridgeLogEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, logEvent: BridgeLogEvent): void => callback(logEvent);
    ipcRenderer.on(bridgeIpcChannels.log, listener);
    return () => {
      ipcRenderer.removeListener(bridgeIpcChannels.log, listener);
    };
  },
  onBridgeStatus: (callback: (snapshot: BridgeProcessSnapshot) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: BridgeProcessSnapshot): void => callback(snapshot);
    ipcRenderer.on(bridgeIpcChannels.status, listener);
    return () => {
      ipcRenderer.removeListener(bridgeIpcChannels.status, listener);
    };
  },
  onBridgeEvent: (callback: (event: BridgeProtocolEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, protocolEvent: BridgeProtocolEvent): void =>
      callback(protocolEvent);
    ipcRenderer.on(bridgeIpcChannels.event, listener);
    return () => {
      ipcRenderer.removeListener(bridgeIpcChannels.event, listener);
    };
  }
};

contextBridge.exposeInMainWorld("legoBridgeUi", desktopApi);

export type LegoBridgeDesktopApi = typeof desktopApi;
