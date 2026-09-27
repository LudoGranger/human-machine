import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, mkdir, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installSkills } from '../scripts/install.mjs';

async function workspace(t) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'human-machine-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('installs self-contained skills and can repeat without changing files', async t => {
  const dir = await workspace(t);
  const first = await installSkills(dir);
  assert.equal(first.skills, 8);
  assert.ok(first.copied > 8);
  assert.match(await readFile(join(dir, 'hm/SKILL.md'), 'utf8'), /name: hm/);
  assert.match(await readFile(join(dir, 'hm/SKILL.md'), 'utf8'), /Pick anyone/);
  for (const name of ['human-machine', 'human-machine-pick', 'human-machine-compare']) {
    assert.match(await readFile(join(dir, name, 'SKILL.md'), 'utf8'), /name: human-machine/);
    assert.match(await readFile(join(dir, name, 'references/context.md'), 'utf8'), /three layers/);
  }
  const second = await installSkills(dir);
  assert.equal(second.copied, 0);
  assert.equal(second.unchanged, first.copied);
});

test('preflights all conflicts and preserves an existing customized skill', async t => {
  const dir = await workspace(t);
  const existing = join(dir, 'human-machine-keep', 'SKILL.md');
  await mkdir(join(dir, 'human-machine-keep'), { recursive: true });
  await writeFile(existing, 'My customized skill');
  await assert.rejects(installSkills(dir), /nothing was written/);
  assert.equal(await readFile(existing, 'utf8'), 'My customized skill');
  await assert.rejects(readFile(join(dir, 'human-machine', 'SKILL.md')), { code: 'ENOENT' });
});

test('refuses destination symlinks instead of writing through them', async t => {
  const dir = await workspace(t);
  const external = join(dir, 'external');
  const destination = join(dir, 'skills');
  await mkdir(external);
  await mkdir(destination);
  await symlink(external, join(destination, 'human-machine'));
  await assert.rejects(installSkills(destination), /symbolic-link destination/);
  await assert.rejects(readFile(join(external, 'SKILL.md')), { code: 'ENOENT' });
});

test('requires an explicit absolute destination', async () => {
  await assert.rejects(installSkills('relative-directory'), /absolute destination/);
});
