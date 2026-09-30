import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

type SourceRuntime = { command: string; args: string[]; root: string };

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
    const command = join(options.resourcesPath, "bridge", filename);
    if (!existsSync(command)) {
      throw new Error("The bundled bridge is missing. Reinstall Axle from a complete release package.");
    }
    mkdirSync(options.userDataPath, { recursive: true });
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
