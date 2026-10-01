import { chmodSync, closeSync, copyFileSync, fsyncSync, lstatSync, mkdtempSync, openSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/** Keep Steam shortcuts valid and never unlink the installed image before copying. */
export function replaceAppImage(installer: string, destination: string): void {
  if (!isAbsolute(destination) || !lstatSync(destination).isFile() || !lstatSync(installer).isFile()) {
    throw new Error("AppImage update requires regular installer and destination files");
  }
  const temporary = mkdtempSync(join(dirname(destination), ".axle-update-"));
  try {
    const replacement = join(temporary, "Axle.AppImage");
    copyFileSync(installer, replacement);
    chmodSync(replacement, 0o755);
    const descriptor = openSync(replacement, "r");
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    // The temporary file shares the destination filesystem: rename is atomic.
    renameSync(replacement, destination);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
