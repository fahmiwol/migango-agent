import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const names = ['package.json', 'package-lock.json', 'CHANGELOG.md'];
const sha = value => createHash('sha256').update(value).digest('hex');

function parseVersion(value) {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-alpha\.(0|[1-9]\d*))?$/.exec(value);
  if (!m) throw Object.assign(new Error('Invalid version; use x.y.z or x.y.z-alpha.N'), { code: 'INVALID_VERSION' });
  return { core: m.slice(1, 4).map(v => BigInt(v)), alpha: m[4] === undefined ? null : BigInt(m[4]) };
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  if (a.alpha === b.alpha) return 0;
  if (a.alpha === null) return 1;
  if (b.alpha === null) return -1;
  return a.alpha > b.alpha ? 1 : -1;
}

function json(text, label) {
  try { return JSON.parse(text); } catch { throw Object.assign(new Error(label + ' must be valid JSON'), { code: 'INVALID_JSON' }); }
}

export function planUpdate({ packageText, lockText, changelog, version, notes, now = new Date() }) {
  const pkg = json(packageText, 'package.json');
  const lock = json(lockText, 'package-lock.json');

  if (!pkg.version || !lock.version) {
    throw Object.assign(new Error('Initial package/lock version mismatch'), { code: 'VERSION_MISMATCH' });
  }
  if (!lock.packages || lock.packages[''] === undefined) {
    throw Object.assign(new Error('Lock packages root missing'), { code: 'LOCK_PACKAGES_ROOT_MISSING' });
  }
  if (pkg.version !== lock.version || pkg.version !== lock.packages[''].version) {
    throw Object.assign(new Error('Initial package/lock version mismatch'), { code: 'VERSION_MISMATCH' });
  }
  if (lock.name !== pkg.name) {
    throw Object.assign(new Error('Lock name mismatch'), { code: 'NAME_MISMATCH' });
  }
  if (lock.lockfileVersion !== 3) {
    throw Object.assign(new Error('lockfileVersion must be 3'), { code: 'LOCKFILE_VERSION_MISMATCH' });
  }

  const order = compare(parseVersion(version), parseVersion(pkg.version));
  if (order === 0) throw Object.assign(new Error('Duplicate/same version'), { code: 'DUPLICATE_VERSION' });
  if (order < 0) throw Object.assign(new Error('Version downgrade rejected'), { code: 'VERSION_DOWNGRADE' });

  if (typeof changelog !== 'string') {
    throw Object.assign(new Error('CHANGELOG must be a string'), { code: 'CHANGELOG_MISSING' });
  }

  // Exactly one multiline '# Changelog' title, optionally followed by a suffix such as ' — miganGO'
  const titleRegex = /^# Changelog(?:[ \t].*)?$/gm;
  const titleMatches = [...changelog.matchAll(titleRegex)];
  if (titleMatches.length === 0) {
    throw Object.assign(new Error('CHANGELOG title missing'), { code: 'CHANGELOG_TITLE_MISSING' });
  }
  if (titleMatches.length > 1) {
    throw Object.assign(new Error('Multiple changelog titles'), { code: 'CHANGELOG_MULTIPLE_TITLES' });
  }

  // Find first semver heading BELOW the title
  const titleMatch = titleMatches[0];
  const afterTitle = changelog.slice(titleMatch.index + titleMatch[0].length);
  const semverRegex = /^##\s+((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-alpha\.(?:0|[1-9]\d*))?)(?:\]|\s|$)/m;
  const semverMatch = semverRegex.exec(afterTitle);
  if (!semverMatch) {
    throw Object.assign(new Error('No semver heading found below changelog title'), { code: 'CHANGELOG_NO_SEMVER' });
  }
  if (semverMatch[1] !== pkg.version) {
    throw Object.assign(new Error('Top semver version mismatch with package version'), { code: 'CHANGELOG_VERSION_MISMATCH' });
  }

  // Check duplicate changelog version
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp('^##\\s+\\[?' + escaped + '(?:\\]|\\s|$)', 'm').test(changelog)) {
    throw Object.assign(new Error('Duplicate changelog version'), { code: 'CHANGELOG_DUPLICATE_VERSION' });
  }

  // Notes validation
  if (!Array.isArray(notes) || notes.length < 1 || notes.length > 20 || notes.some(n => typeof n !== 'string' || !n.trim() || n.length > 500 || /[\r\n]/.test(n))) {
    throw Object.assign(new Error('Notes must contain 1..20 bounded single-line entries'), { code: 'NOTES_INVALID' });
  }
  if (notes.some(n => /sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9_-]{12,}/.test(n))) {
    throw Object.assign(new Error('Credential-shaped notes refused'), { code: 'NOTES_CREDENTIAL_SHAPED' });
  }
  if (!notes.some(n => n.trim().startsWith('WHY:'))) {
    throw Object.assign(new Error('Notes must contain at least one WHY: prefix'), { code: 'NOTES_MISSING_WHY' });
  }

  const dateWIB = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const previousVersion = pkg.version;
  pkg.version = lock.version = lock.packages[''].version = version;

  // Build changelog: insert new section immediately before first semver heading, preserve all prefix bytes
  const firstSemverPos = titleMatch.index + titleMatch[0].length + semverMatch.index;
  const newSection = '## ' + version + ' - ' + dateWIB + ' (WIB)\n' + notes.map(n => '- ' + n.trim()).join('\n');
  const newChangelog = changelog.slice(0, firstSemverPos) + newSection + '\n\n' + changelog.slice(firstSemverPos);

  return {
    files: {
      'package.json': JSON.stringify(pkg, null, 2) + '\n',
      'package-lock.json': JSON.stringify(lock, null, 2) + '\n',
      'CHANGELOG.md': newChangelog,
    },
    planHash: sha(JSON.stringify([packageText, lockText, changelog, version, notes, dateWIB])),
    previousVersion,
    version,
    dateWIB,
  };
}

// Unknown lstat errors count as present so lock checks fail closed.
const pathExists = p => fs.lstat(p).then(() => true, e => e.code !== 'ENOENT' && e.code !== 'ENOTDIR');

// Runs before planning: crash residue can leave mixed versions that planUpdate would misreport.
// Crash leftovers are never rewritten here.
async function assertNoLock(lockDir) {
  if (!(await pathExists(lockDir))) return;
  if (await pathExists(path.join(lockDir, 'manifest.json'))) {
    throw Object.assign(new Error('RECOVERY_REQUIRED: previous update manifest exists'), { code: 'RECOVERY_REQUIRED', cause: new Error('Lock directory contains manifest from previous crash') });
  }
  throw Object.assign(new Error('VERSION_LOCK_HELD: another update is in progress'), { code: 'VERSION_LOCK_HELD' });
}

// Remove the recovery marker before the backups it points to.
async function releaseLock(lockDir) {
  await fs.rm(path.join(lockDir, 'manifest.json'), { force: true });
  for (const name of names) await fs.rm(path.join(lockDir, name + '.orig'), { force: true });
  await fs.rmdir(lockDir);
}

export async function updateVersion({ root, version, notes, now = new Date(), dryRun = true, expectPlan, _beforeRename }) {
  root = await fs.realpath(root);
  const lockDir = path.join(root, '.version-update.lock');
  await assertNoLock(lockDir);

  const originals = {};
  for (const name of names) {
    const p = path.join(root, name);
    const st = await fs.lstat(p);
    if (st.isSymbolicLink()) {
      throw Object.assign(new Error('Version target symlink refused'), { code: 'SYMLINK_REFUSED' });
    }
    originals[name] = await fs.readFile(p, 'utf8');
  }

  const plan = planUpdate({
    packageText: originals[names[0]],
    lockText: originals[names[1]],
    changelog: originals[names[2]],
    version,
    notes,
    now,
  });

  if (dryRun) return plan;

  if (typeof expectPlan !== 'string' || expectPlan !== plan.planHash) {
    throw Object.assign(new Error('Stale or missing expected plan hash'), { code: 'STALE_PLAN' });
  }

  // Atomic lock; losing the race after assertNoLock is still a held lock, not a raw EEXIST.
  try {
    await fs.mkdir(lockDir);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw Object.assign(new Error('VERSION_LOCK_HELD: another update acquired the lock'), { code: 'VERSION_LOCK_HELD', cause: error });
    }
    throw error;
  }

  // Write original backups and manifest under lock
  const manifest = {
    version: plan.version,
    previousVersion: plan.previousVersion,
    dateWIB: plan.dateWIB,
    originals: {},
    originalHashes: {},
    targetHashes: {},
  };

  for (const name of names) {
    const backupName = name + '.orig';
    manifest.originals[name] = backupName;
    manifest.originalHashes[name] = sha(originals[name]);
    manifest.targetHashes[name] = sha(plan.files[name]);
    await fs.writeFile(path.join(lockDir, backupName), originals[name], 'utf8');
  }

  await fs.writeFile(path.join(lockDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  // Fsync original backups and manifest
  for (const name of names) {
    const fd = await fs.open(path.join(lockDir, name + '.orig'), 'r+');
    await fd.sync();
    await fd.close();
  }
  const manifestFd = await fs.open(path.join(lockDir, 'manifest.json'), 'r+');
  await manifestFd.sync();
  await manifestFd.close();

  const written = [];
  const temps = [];
  const allTemps = [];

  try {
    // Verify inputs haven't changed
    for (const name of names) {
      const current = await fs.readFile(path.join(root, name), 'utf8');
      if (current !== originals[name]) {
        throw Object.assign(new Error('Input changed before apply; plan stale'), { code: 'STALE_INPUT' });
      }
    }

    // Write temp files with fsync
    for (const name of names) {
      const temp = path.join(root, name + '.' + randomUUID() + '.tmp');
      const fd = await fs.open(temp, 'wx');
      await fd.writeFile(plan.files[name], 'utf8');
      await fd.sync();
      await fd.close();
      temps.push({ path: temp, name });
      allTemps.push(temp);
    }

    // Rename loop with _beforeRename seam
    for (let i = 0; i < names.length; i++) {
      const name = names[i];

      // Invoke test seam before validation
      if (typeof _beforeRename === 'function') {
        await _beforeRename(i);
      }

      // Validate all prior written targets still equal planned content
      for (let j = 0; j < written.length; j++) {
        const wname = written[j];
        const current = await fs.readFile(path.join(root, wname), 'utf8');
        if (current !== plan.files[wname]) {
          throw Object.assign(
            new Error('Peer modified ' + wname + ' after we wrote it'),
            { code: 'RECOVERY_REQUIRED', cause: new Error('Target ' + wname + ' no longer matches planned content') }
          );
        }
      }

      // Validate current untouched target still equals original; nothing of ours is there yet,
      // so this is a stale input and our earlier writes can be rolled back safely.
      const current = await fs.readFile(path.join(root, name), 'utf8');
      if (current !== originals[name]) {
        throw Object.assign(
          new Error('Peer changed ' + name + ' during apply; plan stale'),
          { code: 'STALE_INPUT', cause: new Error('Target ' + name + ' changed from original before rename') }
        );
      }

      // A peer write between this check and the rename cannot be excluded without OS file locks.
      await fs.rename(temps[i].path, path.join(root, name));
      written.push(name);
    }

    // Final validation after all renames
    for (const name of written) {
      const current = await fs.readFile(path.join(root, name), 'utf8');
      if (current !== plan.files[name]) {
        throw Object.assign(
          new Error('Peer modified ' + name + ' after we wrote it'),
          { code: 'RECOVERY_REQUIRED', cause: new Error('Target ' + name + ' no longer matches planned content after all writes') }
        );
      }
    }
  } catch (error) {
    // Roll back only our own writes; a file whose content is no longer ours is left as is.
    // Each own file is clean only if it reads back equal to its original; read errors are not clean.
    const rollbackErrors = [];
    let clean = true;
    for (const name of written) {
      const target = path.join(root, name);
      try {
        if (await fs.readFile(target, 'utf8') === plan.files[name]) {
          const restoreTemp = path.join(root, name + '.' + randomUUID() + '.restore.tmp');
          allTemps.push(restoreTemp);
          const fd = await fs.open(restoreTemp, 'wx');
          await fd.writeFile(originals[name], 'utf8');
          await fd.sync();
          await fd.close();
          await fs.rename(restoreTemp, target);
        }
        if (await fs.readFile(target, 'utf8') !== originals[name]) clean = false;
      } catch (rbErr) {
        clean = false;
        rollbackErrors.push(rbErr);
      }
    }

    // Clean up all temp files independently
    for (const temp of allTemps) {
      try { await fs.rm(temp, { force: true }); } catch { /* ignore */ }
    }

    // Not clean: keep lock, manifest and backups for recovery, and keep the original error.
    if (!clean) {
      const cause = rollbackErrors.length > 0
        ? new AggregateError([error, ...rollbackErrors], 'Original error and rollback failures')
        : error;
      throw Object.assign(
        new Error('RECOVERY_REQUIRED: ' + (error.message || 'unsafe rollback')),
        { code: 'RECOVERY_REQUIRED', cause }
      );
    }

    // Clean rollback: release lock; a leftover lock fails closed and must not mask the original error.
    try { await releaseLock(lockDir); } catch { /* ignore */ }
    throw error;
  }

  // Committed: data passed final validation, so a cleanup failure must not roll it back.
  try {
    await releaseLock(lockDir);
  } catch (cause) {
    throw Object.assign(new Error('LOCK_CLEANUP_FAILED: update committed but lock cleanup failed'), { code: 'LOCK_CLEANUP_FAILED', cause });
  }
  return plan;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2), opts = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--apply') opts.apply = true;
      else if (['--version', '--notes-file', '--expect-plan'].includes(args[i])) opts[args[i].slice(2)] = args[++i];
      else throw Object.assign(new Error('Unknown version-update option'), { code: 'UNKNOWN_OPTION' });
    }
    if (!opts.version || !opts['notes-file']) {
      throw Object.assign(new Error('Use --version V --notes-file JSON; dry-run first, then --apply --expect-plan HASH'), { code: 'MISSING_ARGUMENTS' });
    }
    const notes = json(await fs.readFile(opts['notes-file'], 'utf8'), 'Notes file');
    const result = await updateVersion({
      root: path.resolve(import.meta.dirname, '..'),
      version: opts.version,
      notes,
      dryRun: !opts.apply,
      expectPlan: opts['expect-plan'],
    });
    console.log(JSON.stringify({ version: result.version, previousVersion: result.previousVersion, dateWIB: result.dateWIB, planHash: result.planHash, dryRun: !opts.apply, files: names }));
  } catch (error) {
    // Exit codes: 2 invalid input or unexpected error, 3 stale, 4 recovery/cleanup needed, 5 lock held.
    const codeMap = {
      STALE_PLAN: 3,
      STALE_INPUT: 3,
      RECOVERY_REQUIRED: 4,
      LOCK_CLEANUP_FAILED: 4,
      VERSION_LOCK_HELD: 5,
    };
    console.error(JSON.stringify({ code: error.code || 'ERROR', message: error.message, cause: error.cause ? String(error.cause.message || error.cause) : undefined }));
    process.exitCode = codeMap[error.code] || 2;
  }
}
