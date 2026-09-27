import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function statIfPresent(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function collectFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Source symlinks are not supported: ' + relative);
    if (entry.isDirectory()) files.push(...await collectFiles(join(directory, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

async function assertSafeParent(path) {
  const state = await statIfPresent(path);
  if (state?.isSymbolicLink()) throw new Error('Refusing a symbolic-link destination: ' + path);
  if (state && !state.isDirectory()) throw new Error('Destination parent is not a directory: ' + path);
  const parent = dirname(path);
  if (parent !== path) await assertSafeParent(parent);
}

/** Install only the declared skill folders; preflight conflicts before any writes. */
export async function installSkills(destination, sourceRoot = projectRoot) {
  if (typeof destination !== 'string' || !isAbsolute(destination)) {
    throw new Error('Provide an absolute destination with --dest.');
  }
  const dest = resolve(destination);
  await assertSafeParent(dest);
  const manifest = JSON.parse(await readFile(join(sourceRoot, 'manifest.json'), 'utf8'));
  if (!Array.isArray(manifest.skills) || !manifest.skills.length ||
      manifest.skills.some(name => !/^(?:hm|human-machine(?:-[a-z]+)*)$/.test(name)) ||
      new Set(manifest.skills).size !== manifest.skills.length) {
    throw new Error('Invalid skill manifest.');
  }

  const writes = [];
  let unchanged = 0;
  const conflicts = [];
  for (const name of manifest.skills) {
    const skillRoot = join(sourceRoot, 'skills', name);
    if (!(await statIfPresent(join(skillRoot, 'SKILL.md')))?.isFile()) {
      throw new Error('Missing skill entrypoint: ' + name);
    }
    for (const relative of await collectFiles(skillRoot)) {
      const from = join(skillRoot, relative);
      const to = join(dest, name, relative);
      await assertSafeParent(dirname(to));
      const state = await statIfPresent(to);
      if (!state) { writes.push({ from, to }); continue; }
      if (!state.isFile() || state.isSymbolicLink()) {
        conflicts.push(to);
      } else if ((await readFile(from)).equals(await readFile(to))) {
        unchanged++;
      } else {
        conflicts.push(to);
      }
    }
  }
  if (conflicts.length) {
    throw new Error('Existing files differ; nothing was written. Preserve or relocate them before retrying:\n' + conflicts.join('\n'));
  }
  for (const { from, to } of writes) {
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to, constants.COPYFILE_EXCL);
  }
  return { version: manifest.version, destination: dest, skills: manifest.skills.length, copied: writes.length, unchanged };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
    console.log('Usage: node scripts/install.mjs --dest /absolute/path/to/project/.claude/skills');
    console.log('Copies hm, the compatibility router and six action skills. No service or provider is configured.');
  } else if (args.length !== 2 || args[0] !== '--dest') {
    console.error('Usage: node scripts/install.mjs --dest /absolute/path/to/skills');
    process.exitCode = 2;
  } else {
    try {
      console.log(JSON.stringify(await installSkills(args[1]), null, 2));
      console.log('Restart or refresh your agent to discover the installed skills.');
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
