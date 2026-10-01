export const releaseRepository = "o-raskin/axle-app";
export const releaseBaseUrl = `https://github.com/${releaseRepository}/releases`;

function versionParts(value: string): number[] | null {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null;
  const parts = value.split(".").map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const next = versionParts(candidate);
  const previous = versionParts(current);
  if (!next || !previous) return false;
  for (let index = 0; index < 3; index += 1) {
    if (next[index] !== previous[index]) return next[index] > previous[index];
  }
  return false;
}

export function manualRelease(value: unknown, platform: string, arch: string): { version: string; url: string } | null {
  if (!value || typeof value !== "object") return null;
  const release = value as { draft?: unknown; prerelease?: unknown; tag_name?: unknown; assets?: unknown };
  if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== "string") return null;
  const version = release.tag_name.replace(/^v/, "");
  if (!versionParts(version) || !Array.isArray(release.assets)) return null;
  const name = platform === "darwin" ? `Axle-${version}-mac-${arch}.dmg` : `Axle-${version}-linux-amd64.deb`;
  const url = `${releaseBaseUrl}/download/${release.tag_name}/${name}`;
  const found = release.assets.some((asset: unknown) => {
    if (!asset || typeof asset !== "object") return false;
    const candidate = asset as { name?: unknown; browser_download_url?: unknown; size?: unknown };
    return candidate.name === name && candidate.browser_download_url === url && typeof candidate.size === "number" && candidate.size > 0;
  });
  return found ? { version, url } : null;
}

type UpdateEngine = {
  check: () => Promise<string | null>;
  download: () => Promise<void>;
  install: () => void;
};

export type UpdateDependencies = {
  enabled: boolean;
  currentVersion: string;
  engine?: UpdateEngine;
  manualCheck: () => Promise<{ version: string; url: string } | null>;
  openDownload: (url: string) => Promise<void>;
  consent: (stage: "download" | "install" | "manual", version: string) => Promise<boolean>;
  notify: (kind: "current" | "error" | "development" | "driving") => Promise<void>;
  isDriving: () => boolean;
  prepareInstall: () => Promise<void>;
  failedInstall: () => void;
  busyChanged: (busy: boolean) => void;
  logError: (error: unknown) => void;
};

/** One startup check; downloads and installation each require explicit consent. */
export class UpdateController {
  private busy = false;
  constructor(private readonly deps: UpdateDependencies) {}

  async check(manual = false): Promise<void> {
    if (this.busy) return;
    const deps = this.deps;
    if (!deps.enabled) {
      if (manual) await deps.notify("development");
      return;
    }
    if (deps.isDriving()) {
      if (manual) await deps.notify("driving");
      return;
    }
    this.busy = true;
    deps.busyChanged(true);
    let accepted = false;
    try {
      const release = deps.engine ? null : await deps.manualCheck();
      const version = deps.engine ? await deps.engine.check() : release?.version;
      if (!version || !isNewerVersion(version, deps.currentVersion)) {
        if (manual) await deps.notify("current");
        return;
      }
      // A drive may have started while the network request was pending.
      if (deps.isDriving()) return;
      if (!deps.engine) {
        accepted = await deps.consent("manual", version);
        if (release && accepted) await deps.openDownload(release.url);
        return;
      }
      accepted = await deps.consent("download", version);
      if (!accepted) return;
      await deps.engine.download();
      // Downloading is allowed in the background, but never interrupt a new drive.
      if (deps.isDriving()) return;
      if (!await deps.consent("install", version)) return;
      // Block new bridge sessions and complete motor cleanup before the installer runs.
      await deps.prepareInstall();
      deps.engine.install();
    } catch (error) {
      deps.failedInstall();
      deps.logError(error);
      if (manual || accepted) await deps.notify("error");
    } finally {
      this.busy = false;
      deps.busyChanged(false);
    }
  }
}
