import { mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTumblerSourceBundle, packTumblerSourceBundle, readTumblerSourceBundle } from './tumbler-source-bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../models/tumbler/source');
const provenancePath = path.join(root, 'provenance.json');
const archivePath = path.join(root, 'cad-source.zip');
const [action, directory, ...extra] = process.argv.slice(2);
if (!['extract', 'pack'].includes(action) || !directory || extra.length) {
  throw new Error('Use model:extract -- <new directory> or model:pack -- <extracted source directory>.');
}
const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
if (action === 'extract') {
  const bundle = await readTumblerSourceBundle(archivePath, provenance.sourceBundle?.sha256);
  await extractTumblerSourceBundle(bundle, path.resolve(directory));
  console.log(`Extracted ${bundle.files.size} source/notice files to ${path.resolve(directory)}. Original license headers are retained.`);
} else {
  const modelRoot = path.dirname(root);
  const originalProvenance = { ...provenance };
  delete originalProvenance.sourceBundle;
  const notice = [
    '# Attribution and rights for this CAD source archive',
    '',
    'This is a lossless source container, not an Axle-owned vehicle design. The original Studio recreation was published by 포기남 (Fogeyman) at https://fogeyman.tistory.com/1770 with CC BY-NC 4.0 terms. Archive packing does not change original CAD bytes or eliminate attribution, noncommercial restrictions or missing underlying permissions.',
    'License: https://creativecommons.org/licenses/by-nc/4.0/legalcode.en',
    'LDraw parts retain their individual author/license/history headers and full agreements in ldraw/. Some supplied or embedded Studio custom geometry has no separate confirmed license. LEGO/DC/Warner Bros. design and trademark rights are not granted by this container. Axle is independent and not sponsored, authorized or endorsed by those parties.',
    '',
    'The following retained notices are copied from the accompanying model package. Repository-relative Markdown links below refer to that package; the original publication and license URLs also appear in this archive for standalone attribution.',
    '',
    await readFile(path.join(modelRoot, 'LICENSE.md'), 'utf8'),
    await readFile(path.join(modelRoot, 'RIGHTS.md'), 'utf8'),
    await readFile(path.join(root, 'LICENSE-EVIDENCE.md'), 'utf8'),
    '## Original-source provenance (container metadata omitted)',
    '', '```json', JSON.stringify(originalProvenance, null, 2), '```', ''
  ].join('\n');
  const bundle = await packTumblerSourceBundle(path.resolve(directory), archivePath, notice);
  provenance.sourceBundle = {
    path: 'cad-source.zip', format: 'zip', sha256: bundle.sha256,
    bytes: bundle.bytes, fileCount: bundle.files.size,
    cadFileCount: bundle.files.size - 1, inventory: 'bundle-manifest.json',
    contents: ['42239.io', '42239.mpd', 'custom/', 'ldraw/', 'ARCHIVE-NOTICE.md'],
    preservation: 'Lossless container; original source bytes, author/license headers and LDraw agreements are retained.'
  };
  const temporaryDirectory = await mkdtemp(path.join(root, '.provenance-'));
  try {
    const temporary = path.join(temporaryDirectory, 'provenance.json');
    await writeFile(temporary, `${JSON.stringify(provenance, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, provenancePath);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  console.log(`Packed ${bundle.files.size - 1} CAD/library files and their rights notice: ${bundle.bytes} bytes, SHA256 ${bundle.sha256}.`);
  console.log('After editing third-party sources, document the changes in provenance.json and rebuild the model. Original-source hash checks remain enforced.');
}
