import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { zipSync, unzipSync } from 'three/addons/libs/fflate.module.js';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const inventoryName = 'bundle-manifest.json';

function sourceName(name) {
  const segments = name.split('/');
  if (!name || name.includes('\\') || name.includes(':') || name.includes('\0')
    || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe CAD archive path: ${name}`);
  }
  return name === '42239.io' || name === '42239.mpd' || name === 'ARCHIVE-NOTICE.md'
    || (name.startsWith('custom/') && name.endsWith('.dat'))
    || (name.startsWith('ldraw/') && /\.(dat|ldr|txt)$/.test(name));
}

/** Preserve every original byte and header; the ZIP is a container, not a mesh conversion. */
export async function readTumblerSourceBundle(archivePath, expectedSha256) {
  const bytes = await readFile(archivePath);
  const digest = sha256(bytes);
  if (expectedSha256 && digest !== expectedSha256) throw new Error('CAD archive checksum mismatch');
  const entries = unzipSync(bytes);
  if (!entries[inventoryName]) throw new Error('CAD archive has no source inventory');
  const manifest = JSON.parse(Buffer.from(entries[inventoryName]).toString('utf8'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || manifest.format !== 1 || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    throw new Error('Unsupported CAD archive inventory');
  }
  const names = Object.keys(manifest.files).sort();
  if (!names.length || Object.keys(entries).length !== names.length + 1) {
    throw new Error('CAD archive inventory does not match its members');
  }
  const files = new Map();
  for (const name of names) {
    if (!sourceName(name)) throw new Error(`Unexpected CAD archive member: ${name}`);
    const file = entries[name];
    const record = manifest.files[name];
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || !Number.isSafeInteger(record.bytes) || record.bytes < 0
      || typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.sha256)
      || !file || file.byteLength !== record.bytes || sha256(file) !== record.sha256) {
      throw new Error(`CAD source checksum mismatch: ${name}`);
    }
    files.set(name, Buffer.from(file));
  }
  if (!files.has('42239.io') || !files.has('42239.mpd') || !files.has('ldraw/LDConfig.ldr') || !files.has('ARCHIVE-NOTICE.md')) {
    throw new Error('CAD archive is missing the original project, assembly, palette or rights notice');
  }
  return { files, manifest, sha256: digest, bytes: bytes.byteLength };
}

export async function packTumblerSourceBundle(directory, archivePath, archiveNotice) {
  const files = new Map();
  async function visit(relative) {
    const absolute = path.join(directory, relative);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`CAD sources cannot contain symlinks: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) await visit(`${relative}/${name}`);
    } else if (stat.isFile()) {
      if (!sourceName(relative)) throw new Error(`Unexpected CAD source: ${relative}`);
      files.set(relative, await readFile(absolute));
    }
  }
  for (const name of ['42239.io', '42239.mpd', 'custom', 'ldraw']) await visit(name);
  if (archiveNotice) files.set('ARCHIVE-NOTICE.md', Buffer.from(archiveNotice));
  else {
    try { await visit('ARCHIVE-NOTICE.md'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const inventory = { format: 1, files: Object.fromEntries([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, bytes]) => [name, { bytes: bytes.byteLength, sha256: sha256(bytes) }])) };
  const entries = Object.fromEntries([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  entries[inventoryName] = Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`);
  const bytes = zipSync(entries, { level: 9, mtime: new Date(1980, 0, 1) });
  await mkdir(path.dirname(archivePath), { recursive: true });
  const temporaryDirectory = await mkdtemp(path.join(path.dirname(archivePath), '.cad-source-'));
  const temporary = path.join(temporaryDirectory, 'bundle.zip');
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    const bundle = await readTumblerSourceBundle(temporary, sha256(bytes));
    await rename(temporary, archivePath);
    return bundle;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

/** Refuse an existing destination; never overwrite a user's extracted edits. */
export async function extractTumblerSourceBundle(bundle, destination) {
  for (const name of bundle.files.keys()) {
    if (!sourceName(name)) throw new Error(`Unexpected CAD archive member: ${name}`);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await mkdir(destination);
  for (const [name, bytes] of bundle.files) {
    const target = path.join(destination, ...name.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
  }
}
