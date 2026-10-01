import { app, BrowserWindow, dialog, net, shell, type MessageBoxOptions } from "electron";
import { AppImageUpdater, NsisUpdater } from "electron-updater";
import { replaceAppImage } from "./appImageUpdate";
import { manualRelease, releaseRepository, UpdateController } from "./updateController";

class StableAppImageUpdater extends AppImageUpdater {
  protected doInstall(options: { isForceRunAfter: boolean }): boolean {
    const destination = process.env.APPIMAGE;
    if (!destination || !this.installerPath) throw new Error("AppImage update paths are missing");
    replaceAppImage(this.installerPath, destination);
    if (options.isForceRunAfter) {
      void this.spawnLog(destination, [], { ...process.env, APPIMAGE_SILENT_INSTALL: "true" });
    }
    return true;
  }
}

export function createAppUpdates(options: {
  isDriving: () => boolean;
  prepareInstall: () => Promise<void>;
  failedInstall: () => void;
  busyChanged: (busy: boolean) => void;
}): UpdateController {
  const enabled = app.isPackaged && !app.commandLine.hasSwitch("disable-update-check");
  const updater = enabled && process.platform === "win32" ? new NsisUpdater()
    : enabled && process.platform === "linux" && process.env.APPIMAGE ? new StableAppImageUpdater() : undefined;
  let installing = false;
  const showDialog = (message: MessageBoxOptions) => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    return window ? dialog.showMessageBox(window, message) : dialog.showMessageBox(message);
  };
  const notify = async (message: string, detail: string): Promise<void> => {
    await showDialog({ type: "info", title: "Axle updates", message, detail, buttons: ["OK"] });
  };
  if (updater) {
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    // Full downloads avoid requiring old blockmaps and work across existing releases.
    updater.disableDifferentialDownload = true;
    updater.logger = console;
    updater.on("error", (error) => {
      console.error("Axle update failed", error);
      options.failedInstall();
      if (installing) {
        installing = false;
        void notify("The update could not be installed", "Your current Axle installation is still available. Try Check for updates again.")
          .catch((notificationError: unknown) => { console.error(notificationError); });
      }
    });
    updater.on("download-progress", (progress) => {
      for (const window of BrowserWindow.getAllWindows()) window.setProgressBar(progress.percent / 100);
    });
  }
  return new UpdateController({
    ...options,
    enabled,
    currentVersion: app.getVersion(),
    engine: updater ? {
      check: async () => (await updater.checkForUpdates())?.updateInfo.version ?? null,
      download: async () => { await updater.downloadUpdate(); },
      install: () => { installing = true; updater.quitAndInstall(false, true); }
    } : undefined,
    manualCheck: async () => {
      const response = await net.fetch(`https://api.github.com/repos/${releaseRepository}/releases/latest`, {
        headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
        signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) throw new Error(`Release check returned HTTP ${response.status}`);
      const release = manualRelease(await response.json(), process.platform, process.arch);
      if (!release) throw new Error("Latest release has no compatible installer");
      return release;
    },
    openDownload: async (url) => { await shell.openExternal(url); },
    consent: async (stage, version) => {
      const download = stage === "download";
      const manual = stage === "manual";
      const answer = await showDialog({
        type: "info", title: "Axle updates",
        message: manual || download ? `Axle ${version} is available` : `Axle ${version} is ready to install`,
        detail: manual
          ? process.platform === "darwin"
            ? "Download the new installer from GitHub and replace Axle in Applications. This build is not signed with Apple Developer ID, so installation requires your macOS approval."
            : "Download the new package from GitHub and install it with your system's package manager."
          : download ? "Download the update in the background? You will be asked again before Axle restarts."
            : "Axle will stop vehicle control, install the update and restart. Your current session will end.",
        buttons: ["Later", manual ? "Download installer" : download ? "Download update" : "Restart and install"],
        defaultId: 0, cancelId: 0, noLink: true
      });
      if (download && answer.response === 1) {
        for (const window of BrowserWindow.getAllWindows()) window.setProgressBar(2);
      }
      return answer.response === 1;
    },
    notify: async (kind) => {
      const messages = {
        current: ["Axle is up to date", `You are using Axle ${app.getVersion()}.`],
        error: ["The update could not be completed", "Your current installation is still available. Check your connection and try Check for updates again."],
        development: ["Updates are available in installed builds", "Development builds do not check for or install release updates."],
        driving: ["Stop vehicle control first", "End the current session, then check for updates again."]
      } as const;
      const [message, detail] = messages[kind];
      await notify(message, detail);
    },
    busyChanged: (busy) => {
      options.busyChanged(busy);
      if (!busy) {
        for (const window of BrowserWindow.getAllWindows()) window.setProgressBar(-1);
      }
    },
    logError: (error) => { console.error("Could not complete Axle update", error); }
  });
}
