import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

type SourceRuntime = { command: string; args: string[]; root: string };

const appImageRuntimes = new Map<string, { directory: string; command: string }>();
let cleanupRegistered = false;

/** Remove only private copies created by this process, after the bridge has stopped. */
export function cleanupBridgeRuntimes(): void {
  for (const runtime of appImageRuntimes.values()) {
    rmSync(runtime.directory, { recursive: true, force: true });
  }
  appImageRuntimes.clear();
}

function appImageBridge(source: string, userDataPath: string, filename: string): string {
  const key = JSON.stringify([source, userDataPath]);
  const existing = appImageRuntimes.get(key);
  if (existing) return existing.command;

  // SquashFUSE can return EINVAL for security.capability. PyInstaller correctly
  // refuses to run when that check fails. Run an identical private copy on the
  // user's filesystem; keep the bootloader's security checks intact.
  const directory = mkdtempSync(join(userDataPath, ".bridge-runtime-"));
  const command = join(directory, filename);
  try {
    copyFileSync(source, command);
    chmodSync(command, 0o700);
    appImageRuntimes.set(key, { directory, command });
    if (!cleanupRegistered) {
      process.once("exit", cleanupBridgeRuntimes);
      cleanupRegistered = true;
    }
    return command;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export type BridgeLaunch = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

/** Packaged apps always use their own bridge; source discovery is development-only. */
export function resolveBridgeLaunch(
  options: {
    isPackaged: boolean;
    resourcesPath: string;
    userDataPath: string;
    platform: NodeJS.Platform;
    environment: NodeJS.ProcessEnv;
  },
  resolveSource: () => SourceRuntime
): BridgeLaunch {
  const env = {
    ...options.environment,
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
    SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS: options.environment.SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS ?? "1"
  };

  if (options.isPackaged) {
    const filename = `lego-technic-gamepad-bridge${options.platform === "win32" ? ".exe" : ""}`;
    let command = join(options.resourcesPath, "bridge", filename);
    if (!existsSync(command)) {
      throw new Error("The bundled bridge is missing. Reinstall Axle from a complete release package.");
    }
    mkdirSync(options.userDataPath, { recursive: true });
    if (options.platform === "linux" && options.environment.APPIMAGE) {
      command = appImageBridge(command, options.userDataPath, filename);
    }
    return {
      command,
      args: ["--frontend", "jsonl"],
      cwd: options.userDataPath,
      env: { ...env, LEGO_BRIDGE_HOME: options.userDataPath }
    };
  }

  const source = resolveSource();
  return {
    command: source.command,
    args: [...source.args, "-u", join(source.root, "gamepad_bridge.py"), "--frontend", "jsonl"],
    cwd: source.root,
    env
  };
}
