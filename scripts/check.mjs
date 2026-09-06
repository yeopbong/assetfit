import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
for (const directory of ['src', 'web', 'scripts', 'tests']) {
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(path.join(directory, entry.name));
  }
}
for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    console.error(`Syntax validation failed: ${file}`);
    console.error(result.error?.message ?? result.stderr);
    process.exit(1);
  }
}
console.log(`Syntax validated for ${files.length} implementation, browser, script and test modules.`);
