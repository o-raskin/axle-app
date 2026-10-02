import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultDesktopSettings, type DesktopSettings } from "../shared/settings";

function normalizeSettings(value: unknown): DesktopSettings {
  const candidate = value && typeof value === "object" ? value as Partial<DesktopSettings> : {};
  return {
    launchFullscreen: typeof candidate.launchFullscreen === "boolean"
      ? candidate.launchFullscreen : defaultDesktopSettings.launchFullscreen
  };
}

export class DesktopSettingsStore {
  constructor(private readonly path: string) {}

  read(): DesktopSettings {
    try { return normalizeSettings(JSON.parse(readFileSync(this.path, "utf8"))); }
    catch { return { ...defaultDesktopSettings }; }
  }

  update(patch: unknown): DesktopSettings {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Invalid settings patch");
    const candidate = patch as Partial<DesktopSettings>;
    if (candidate.launchFullscreen !== undefined && typeof candidate.launchFullscreen !== "boolean") {
      throw new Error("Fullscreen preference must be a boolean");
    }
    const settings = { ...this.read() };
    if (typeof candidate.launchFullscreen === "boolean") settings.launchFullscreen = candidate.launchFullscreen;
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true });
    const temporary = mkdtempSync(join(directory, ".desktop-settings-"));
    try {
      const replacement = join(temporary, "settings.json");
      writeFileSync(replacement, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
      // A failed write cannot truncate the last usable preference file.
      renameSync(replacement, this.path);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
    return settings;
  }
}
