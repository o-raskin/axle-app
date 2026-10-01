/// <reference types="vite/client" />

import type { BootstrapState } from "../../shared/bootstrap";
import type {
  BridgeActionResult,
  BridgeCommandRequest,
  BridgeLogEvent,
  BridgeProcessSnapshot,
  BridgeProtocolEvent,
  BridgeProfileCatalog,
  BridgeStartOptions
} from "../../shared/bridge";
import type { DesktopSettings, DesktopSettingsPatch } from "../../shared/settings";

declare global {
  interface Window {
    legoBridgeUi: {
      quitApp: () => Promise<BridgeActionResult>;
      discoverHardware: () => Promise<BridgeActionResult>;
      getBootstrapState: () => Promise<BootstrapState>;
      getSettings: () => Promise<DesktopSettings>;
      updateSettings: (patch: DesktopSettingsPatch) => Promise<DesktopSettings>;
      getBridgeProfiles: () => Promise<BridgeProfileCatalog>;
      getBridgeStatus: () => Promise<BridgeProcessSnapshot>;
      startBridge: (options: BridgeStartOptions) => Promise<BridgeActionResult>;
      stopBridge: () => Promise<BridgeActionResult>;
      runBridgeCommand: (request: BridgeCommandRequest) => Promise<BridgeActionResult>;
      onBridgeLog: (callback: (event: BridgeLogEvent) => void) => () => void;
      onBridgeStatus: (callback: (snapshot: BridgeProcessSnapshot) => void) => () => void;
      onBridgeEvent: (callback: (event: BridgeProtocolEvent) => void) => () => void;
    };
  }
}

export {};
