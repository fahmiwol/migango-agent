// Kimi test draft; host corrected escaping, hash-contract and header assertion before implementation.
// CTO-authorized contract corrections (opus-cli-cto-review2 T1-T4/R5): R1 exact changelog + error codes, R5 peer content kept, R6 seam index 2, R7 realistic manifest + mixed crash.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { planUpdate, updateVersion } from '../../scripts/version-update.mjs';

const FIXTURE_VERSION = '0.1.0';

function makeFixturePackage(version = FIXTURE_VERSION) {
  return JSON.stringify({
    name: 'fixture',
    version,
    dependencies: { sample: '1.0.0' },
  }, null, 2);
}

function makeFixtureLock(version = FIXTURE_VERSION) {
  return JSON.stringify({
    name: 'fixture',
    version,
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture', version, dependencies: { sample: '1.0.0' } },
      'node_modules/sample': { version: '1.0.0' },
    },
  }, null, 2);
}

function makeFixtureChangelog(version = FIXTURE_VERSION) {
  return `# Changelog\n\n## ${version}\n\n- Initial release\n`;
}

function makeNotes() {
  return ['WHY: Add new feature alpha', 'Fix test harness'];
}

function makeNow() {
  return new Date('2026-10-24T17:30:00.000Z');
}

async function setupTmpDir(root, version = FIXTURE_VERSION) {
  await fs.promises.mkdir(root, { recursive: true });
  await fs.promises.writeFile(path.join(root, 'package.json'), makeFixturePackage(version), 'utf8');
  await fs.promises.writeFile(path.join(root, 'package-lock.json'), makeFixtureLock(version), 'utf8');
  await fs.promises.writeFile(path.join(root, 'CHANGELOG.md'), makeFixtureChangelog(version), 'utf8');
}

async function readThree(root) {
  const [pkg, lock, chg] = await Promise.all([
    fs.promises.readFile(path.join(root, 'package.json'), 'utf8'),
    fs.promises.readFile(path.join(root, 'package-lock.json'), 'utf8'),
    fs.promises.readFile(path.join(root, 'CHANGELOG.md'), 'utf8'),
  ]);
  return { packageJson: pkg, packageLockJson: lock, changelogMd: chg };
}

async function listTmpDebris(root) {
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  return entries
    .filter(e => e.name.endsWith('.tmp') || e.name === '.version-update.lock')
    .map(e => e.name);
}

describe('version-update', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vu-test-'));
    await setupTmpDir(tmpDir);
  });
  afterEach(async()=>{if(!tmpDir.startsWith(path.join(os.tmpdir(),'vu-test-')))throw Error('Unsafe fixture cleanup');await fs.promises.rm(tmpDir,{recursive:true,force:true});});

  it('dryRun must leave all 3 file bytes unchanged', async () => {
    const before = await readThree(tmpDir);
    const plan = planUpdate({
      packageText: before.packageJson,
      lockText: before.packageLockJson,
      changelog: before.changelogMd,
      version: '0.2.0-alpha.1',
      notes: makeNotes(),
      now: makeNow(),
    });
    assert.ok(plan.planHash, 'planHash must be present');

    await updateVersion({
      root: tmpDir,
      version: '0.2.0-alpha.1',
      notes: makeNotes(),
      now: makeNow(),
      dryRun: true,
      expectPlan: plan.planHash,
    });

    const after = await readThree(tmpDir);
    assert.strictEqual(after.packageJson, before.packageJson, 'package.json must not change in dryRun');
    assert.strictEqual(after.packageLockJson, before.packageLockJson, 'package-lock.json must not change in dryRun');
    assert.strictEqual(after.changelogMd, before.changelogMd, 'CHANGELOG.md must not change in dryRun');
  });

  it('apply 0.1.0 -> 0.2.0-alpha.1 with fixed date WIB, version fields match, dependencies deepEqual', async () => {
    const before = await readThree(tmpDir);
    const plan = planUpdate({
      packageText: before.packageJson,
      lockText: before.packageLockJson,
      changelog: before.changelogMd,
      version: '0.2.0-alpha.1',
      notes: makeNotes(),
      now: makeNow(),
    });

    assert.strictEqual(plan.previousVersion, '0.1.0');
    assert.strictEqual(plan.version, '0.2.0-alpha.1');
    assert.strictEqual(plan.dateWIB, '2026-10-25');

    const result = await updateVersion({
      root: tmpDir,
      version: '0.2.0-alpha.1',
      notes: makeNotes(),
      now: makeNow(),
      dryRun: false,
      expectPlan: plan.planHash,
    });
    assert.deepStrictEqual(result, plan, 'apply must match the approved plan');

    const after = await readThree(tmpDir);
    const pkg = JSON.parse(after.packageJson);
    const lock = JSON.parse(after.packageLockJson);
    const chg = after.changelogMd;

    assert.strictEqual(pkg.version, '0.2.0-alpha.1', 'package.json version must be updated');
    assert.strictEqual(lock.version, '0.2.0-alpha.1', 'lock root version must be updated');
    assert.strictEqual(lock.packages[''].version, '0.2.0-alpha.1', "lock packages[''] version must be updated");
    assert.strictEqual(chg.includes('0.2.0-alpha.1'), true, 'CHANGELOG must contain new version header');
    assert.deepStrictEqual(pkg.dependencies, { sample: '1.0.0' }, 'package.json dependencies must remain unchanged');
    assert.deepStrictEqual(lock.packages[''].dependencies, { sample: '1.0.0' }, "lock packages[''] dependencies must remain unchanged");
    assert.strictEqual(chg.includes(makeNotes()[0]), true, 'CHANGELOG must include first note');
    assert.strictEqual(chg.includes(makeNotes()[1]), true, 'CHANGELOG must include second note');
    assert.ok(chg.startsWith('# Changelog\n\n## 0.2.0-alpha.1 - 2026-10-25 (WIB)'), 'version section follows title with dateWIB, unbracketed format per R1/R8 contract');
  });

  it('downgrade and duplicate versions are rejected, and alpha.10 > alpha.2 numerically', () => {
    const base = {
      packageText: makeFixturePackage(),
      lockText: makeFixtureLock(),
      changelog: makeFixtureChangelog(),
      notes: makeNotes(),
      now: makeNow(),
    };

    assert.throws(
      () => planUpdate({ ...base, version: '0.1.0' }),
      (err) => err.message.toLowerCase().includes('duplicate') || err.message.toLowerCase().includes('same'),
      'duplicate version must be rejected'
    );

    assert.throws(
      () => planUpdate({ ...base, version: '0.0.9' }),
      (err) => err.message.toLowerCase().includes('downgrade') || err.message.toLowerCase().includes('lower'),
      'downgrade version must be rejected'
    );

    assert.doesNotThrow(
      () => planUpdate({ ...base, version: '0.2.0-alpha.2' }),
      'alpha.2 as a higher prerelease must be accepted'
    );

    assert.doesNotThrow(
      () => planUpdate({ ...base, version: '0.2.0-alpha.10' }),
      'alpha.10 as a higher numeric prerelease must be accepted'
    );
  });

  it('lock root version initially inconsistent is rejected and nothing written', async () => {
    const badLock = JSON.stringify({
      name: 'fixture',
      version: '9.9.9',
      lockfileVersion: 3,
      packages: {
        '': { name: 'fixture', version: '0.1.0', dependencies: { sample: '1.0.0' } },
        'node_modules/sample': { version: '1.0.0' },
      },
    }, null, 2);

    const before = await readThree(tmpDir);
    assert.throws(
      () => planUpdate({
        packageText: before.packageJson,
        lockText: badLock,
        changelog: before.changelogMd,
        version: '0.2.0-alpha.1',
        notes: makeNotes(),
        now: makeNow(),
      }),
      (err) => err.message.toLowerCase().includes('lock') || err.message.toLowerCase().includes('mismatch') || err.message.toLowerCase().includes('inconsistent'),
      'inconsistent lock version must be rejected during planning'
    );

    // Ensure filesystem untouched even if someone incorrectly called updateVersion after a failed plan
    const after = await readThree(tmpDir);
    assert.strictEqual(after.packageJson, before.packageJson);
    assert.strictEqual(after.packageLockJson, before.packageLockJson);
    assert.strictEqual(after.changelogMd, before.changelogMd);
  });

  it('tampering dependency after dryRun then apply with stale expectPlan is rejected and files not overwritten', async () => {
    const before = await readThree(tmpDir);
    const plan = planUpdate({
      packageText: before.packageJson,
      lockText: before.packageLockJson,
      changelog: before.changelogMd,
      version: '0.2.0-alpha.1',
      notes: makeNotes(),
      now: makeNow(),
    });

    // dryRun with original plan succeeds (and does not write)
    await updateVersion({
      root: tmpDir,
      version: '0.2.0-alpha.1',
      notes: makeNotes(),
      now: makeNow(),
      dryRun: true,
      expectPlan: plan.planHash,
    });

    // tamper dependency in package.json on disk
    const tamperedPkg = JSON.parse(before.packageJson);
    tamperedPkg.dependencies.sample = '9.9.9';
    await fs.promises.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify(tamperedPkg, null, 2), 'utf8');

    // apply with stale plan must reject because file on disk changed (hash/plan mismatch)
    await assert.rejects(
      async () => updateVersion({
        root: tmpDir,
        version: '0.2.0-alpha.1',
        notes: makeNotes(),
        now: makeNow(),
        dryRun: false,
        expectPlan: plan.planHash,
      }),
      (err) => err.message.toLowerCase().includes('tamper') || err.message.toLowerCase().includes('mismatch') || err.message.toLowerCase().includes('stale') || err.message.toLowerCase().includes('hash') || err.message.toLowerCase().includes('plan'),
      'stale expectPlan after tamper must be rejected'
    );

    // ensure tampered file stays, not overwritten by apply
    const after = await readThree(tmpDir);
    const pkg = JSON.parse(after.packageJson);
    assert.strictEqual(pkg.dependencies.sample, '9.9.9', 'tampered package.json must remain untouched after rejected apply');
    assert.strictEqual(after.packageLockJson, before.packageLockJson, 'package-lock.json must remain unchanged');
    assert.strictEqual(after.changelogMd, before.changelogMd, 'CHANGELOG.md must remain unchanged');
  });

  it('base 0.2.0-alpha.2 -> alpha.10 accepted; base alpha.10 -> alpha.2 rejected', () => {
    const baseAlpha2 = {
      packageText: makeFixturePackage('0.2.0-alpha.2'),
      lockText: makeFixtureLock('0.2.0-alpha.2'),
      changelog: '# Changelog\n\n## 0.2.0-alpha.2\n\n- Note two\n',
      notes: makeNotes(),
      now: makeNow(),
    };

    assert.doesNotThrow(
      () => planUpdate({ ...baseAlpha2, version: '0.2.0-alpha.10' }),
      'alpha.10 higher than alpha.2 must be accepted'
    );

    const baseAlpha10 = {
      packageText: makeFixturePackage('0.2.0-alpha.10'),
      lockText: makeFixtureLock('0.2.0-alpha.10'),
      changelog: '# Changelog\n\n## 0.2.0-alpha.10\n\n- Note ten\n',
      notes: makeNotes(),
      now: makeNow(),
    };

    assert.throws(
      () => planUpdate({ ...baseAlpha10, version: '0.2.0-alpha.2' }),
      (err) => err.message.toLowerCase().includes('downgrade') || err.message.toLowerCase().includes('lower'),
      'alpha.2 lower than alpha.10 must be rejected'
    );
  });

  it('alpha -> stable accepted; stable -> same-base alpha rejected', () => {
    const baseAlpha = {
      packageText: makeFixturePackage('0.2.0-alpha.5'),
      lockText: makeFixtureLock('0.2.0-alpha.5'),
      changelog: '# Changelog\n\n## 0.2.0-alpha.5\n\n- Note alpha\n',
      notes: makeNotes(),
      now: makeNow(),
    };

    assert.doesNotThrow(
      () => planUpdate({ ...baseAlpha, version: '0.2.0' }),
      'stable after alpha must be accepted'
    );

    const baseStable = {
      packageText: makeFixturePackage('0.2.0'),
      lockText: makeFixtureLock('0.2.0'),
      changelog: '# Changelog\n\n## 0.2.0\n\n- Note stable\n',
      notes: makeNotes(),
      now: makeNow(),
    };

    assert.throws(
      () => planUpdate({ ...baseStable, version: '0.2.0-alpha.1' }),
      (err) => err.message.toLowerCase().includes('downgrade') || err.message.toLowerCase().includes('lower'),
      'same-base alpha after stable must be rejected as downgrade'
    );
  });

  it('filesystem inconsistent lock version only is rejected and all three file bytes remain equal to baseline', async () => {
    // Set up a tmpDir with a lock whose root version differs from package.json
    const inconsistentTmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vu-test-'));
    try {
      await setupTmpDir(inconsistentTmp);
      const before = await readThree(inconsistentTmp);

      // Mutate only lockfile version on disk
      const lockObj = JSON.parse(before.packageLockJson);
      lockObj.version = '9.9.9';
      lockObj.packages[''].version = '9.9.9';
      const mutatedLock = JSON.stringify(lockObj, null, 2);
      await fs.promises.writeFile(path.join(inconsistentTmp, 'package-lock.json'), mutatedLock, 'utf8');

      const baseline = await readThree(inconsistentTmp);

      await assert.rejects(
        async () => updateVersion({
          root: inconsistentTmp,
          version: '0.2.0-alpha.1',
          notes: makeNotes(),
          now: makeNow(),
          dryRun: false,
          expectPlan: 'any-hash-will-fail-because-plan-rejects-first',
        }),
        (err) => err.message.toLowerCase().includes('mismatch') || err.message.toLowerCase().includes('lock') || err.message.toLowerCase().includes('inconsistent'),
        'inconsistent lock version on filesystem must be rejected'
      );

      const after = await readThree(inconsistentTmp);
      assert.strictEqual(after.packageJson, baseline.packageJson, 'package.json must remain unchanged after rejected update');
      assert.strictEqual(after.packageLockJson, baseline.packageLockJson, 'package-lock.json must remain unchanged after rejected update');
      assert.strictEqual(after.changelogMd, baseline.changelogMd, 'CHANGELOG.md must remain unchanged after rejected update');
    } finally {
      if (inconsistentTmp.startsWith(path.join(os.tmpdir(), 'vu-test-'))) {
        await fs.promises.rm(inconsistentTmp, { recursive: true, force: true });
      }
    }
  });

  it('apply without expectPlan or with wrong plan hash is rejected and no files written', async () => {
    const before = await readThree(tmpDir);

    await assert.rejects(
      async () => updateVersion({
        root: tmpDir,
        version: '0.2.0-alpha.1',
        notes: makeNotes(),
        now: makeNow(),
        dryRun: false,
        // expectPlan intentionally omitted
      }),
      (err) => err.message.toLowerCase().includes('stale') || err.message.toLowerCase().includes('plan') || err.message.toLowerCase().includes('hash') || err.message.toLowerCase().includes('missing'),
      'apply without expectPlan must be rejected'
    );

    let after = await readThree(tmpDir);
    assert.strictEqual(after.packageJson, before.packageJson, 'package.json must not change when expectPlan missing');
    assert.strictEqual(after.packageLockJson, before.packageLockJson, 'package-lock.json must not change when expectPlan missing');
    assert.strictEqual(after.changelogMd, before.changelogMd, 'CHANGELOG.md must not change when expectPlan missing');

    const plan = planUpdate({
      packageText: before.packageJson,
      lockText: before.packageLockJson,
      changelog: before.changelogMd,
      version: '0.2.0-alpha.1',
      notes: makeNotes(),
      now: makeNow(),
    });

    await assert.rejects(
      async () => updateVersion({
        root: tmpDir,
        version: '0.2.0-alpha.1',
        notes: makeNotes(),
        now: makeNow(),
        dryRun: false,
        expectPlan: plan.planHash + '-wrong',
      }),
      (err) => err.message.toLowerCase().includes('stale') || err.message.toLowerCase().includes('plan') || err.message.toLowerCase().includes('hash'),
      'apply with wrong expectPlan must be rejected'
    );

    after = await readThree(tmpDir);
    assert.strictEqual(after.packageJson, before.packageJson, 'package.json must not change when expectPlan wrong');
    assert.strictEqual(after.packageLockJson, before.packageLockJson, 'package-lock.json must not change when expectPlan wrong');
    assert.strictEqual(after.changelogMd, before.changelogMd, 'CHANGELOG.md must not change when expectPlan wrong');
  });

  it('existing .version-update.lock blocks concurrent apply and leaves files untouched', async () => {
    const before = await readThree(tmpDir);
    const plan = planUpdate({
      packageText: before.packageJson,
      lockText: before.packageLockJson,
      changelog: before.changelogMd,
      version: '0.2.0-alpha.1',
      notes: makeNotes(),
      now: makeNow(),
    });

    // Pre-create the lock directory to simulate a concurrent update
    await fs.promises.mkdir(path.join(tmpDir, '.version-update.lock'));

    await assert.rejects(
      async () => updateVersion({
        root: tmpDir,
        version: '0.2.0-alpha.1',
        notes: makeNotes(),
        now: makeNow(),
        dryRun: false,
        expectPlan: plan.planHash,
      }),
      (err) => err.message.toLowerCase().includes('lock') || err.message.toLowerCase().includes('exist') || err.code === 'EEXIST',
      'existing .version-update.lock must block apply'
    );

    const after = await readThree(tmpDir);
    assert.strictEqual(after.packageJson, before.packageJson, 'package.json must remain when lock exists');
    assert.strictEqual(after.packageLockJson, before.packageLockJson, 'package-lock.json must remain when lock exists');
    assert.strictEqual(after.changelogMd, before.changelogMd, 'CHANGELOG.md must remain when lock exists');
  });

  // ========== R1: Real-shaped CHANGELOG fixture ==========
  it('R1: real-shaped changelog with journal text before title, no brackets around version, rejects zero/multiple titles or mismatched top semver', () => {
    const realChangelog =
      '## miganGO perbaikan K06 + K01 atas vonis gate — 23 Oktober 2026 (claude-agents, cloud)\n\n' +
      'WHY: gate SSH menolak K06.\n\n' +
      '## miganGO kartu K3, K2-dok — 23 Oktober 2026 (claude-agents)\n\n' +
      'WHY: the owner ingin miganGO andal.\n\n' +
      '# Changelog — miganGO\n\n' +
      'Format: semver, tiap entri menulis WHY.\n\n' +
      '## 0.1.0 - 2026-10-21\n' +
      '- Proyek dibuat dengan Standar Proyek Tiranyx v1.\n' +
      '- WHY: pemilik memerlukan desktop agent tanpa CLI.\n';

    const pkgText = JSON.stringify({ name: 'migango', version: '0.1.0', dependencies: { a: '1.0.0' } }, null, 2);
    const lockText = JSON.stringify({
      name: 'migango', version: '0.1.0', lockfileVersion: 3,
      packages: { '': { name: 'migango', version: '0.1.0', dependencies: { a: '1.0.0' } } },
    }, null, 2);

    // Valid real-shaped fixture accepted
    const plan = planUpdate({
      packageText: pkgText,
      lockText,
      changelog: realChangelog,
      version: '0.2.0-alpha.1',
      notes: ['WHY: test new feature'],
      now: makeNow(),
    });
    assert.strictEqual(plan.previousVersion, '0.1.0');
    assert.strictEqual(plan.version, '0.2.0-alpha.1');

    // R1 contract: original prefix byte-for-byte + new unbracketed section with its WHY note + original body
    const at = realChangelog.indexOf('## 0.1.0 - 2026-10-21');
    assert.strictEqual(
      plan.files['CHANGELOG.md'],
      realChangelog.slice(0, at) + '## 0.2.0-alpha.1 - 2026-10-25 (WIB)\n- WHY: test new feature\n\n' + realChangelog.slice(at),
      'new section must be inserted right before the first semver block with all other bytes preserved'
    );

    // Zero changelog titles rejected independently
    assert.throws(
      () => planUpdate({
        packageText: pkgText,
        lockText,
        changelog: 'Just some text without a title\n\n## 0.1.0 - 2026-10-21\n',
        version: '0.2.0-alpha.1',
        notes: ['WHY: x'],
        now: makeNow(),
      }),
      (err) => err.message.toLowerCase().includes('title') || err.message.toLowerCase().includes('missing'),
      'zero changelog titles must be rejected'
    );

    // Multiple changelog titles rejected independently
    assert.throws(
      () => planUpdate({
        packageText: pkgText,
        lockText,
        changelog: '# Changelog — A\n\n# Changelog — B\n\n## 0.1.0 - 2026-10-21\n',
        version: '0.2.0-alpha.1',
        notes: ['WHY: x'],
        now: makeNow(),
      }),
      (err) => err.code === 'CHANGELOG_MULTIPLE_TITLES',
      'multiple changelog titles must be rejected'
    );

    // Top semver inconsistent with package version rejected independently
    assert.throws(
      () => planUpdate({
        packageText: pkgText,
        lockText,
        changelog:
          '# Changelog — miganGO\n\n' +
          '## 9.9.9 - 2026-10-21\n' +
          '- Initial\n',
        version: '0.2.0-alpha.1',
        notes: ['WHY: x'],
        now: makeNow(),
      }),
      (err) => err.code === 'CHANGELOG_VERSION_MISMATCH',
      'top semver inconsistent with pkg version must be rejected'
    );
  });

  // ========== R2: Additional prerelease and malformed version cases ==========
  it('R2: 0.9.0 -> 0.10.0 accepted; malformed versions rejected', () => {
    const base09 = {
      packageText: makeFixturePackage('0.9.0'),
      lockText: makeFixtureLock('0.9.0'),
      changelog: '# Changelog\n\n## 0.9.0\n\n- Note\n',
      notes: makeNotes(),
      now: makeNow(),
    };

    assert.doesNotThrow(
      () => planUpdate({ ...base09, version: '0.10.0' }),
      '0.9.0 -> 0.10.0 must be accepted'
    );

    // Leading zero
    assert.throws(
      () => planUpdate({ ...base09, version: '01.0.0' }),
      (err) => err.message.toLowerCase().includes('invalid') || err.message.toLowerCase().includes('version'),
      'leading zero version must be rejected'
    );

    // v prefix
    assert.throws(
      () => planUpdate({ ...base09, version: 'v1.0.0' }),
      (err) => err.message.toLowerCase().includes('invalid') || err.message.toLowerCase().includes('version'),
      'v-prefixed version must be rejected'
    );

    // beta (not alpha)
    assert.throws(
      () => planUpdate({ ...base09, version: '1.0.0-beta.1' }),
      (err) => err.message.toLowerCase().includes('invalid') || err.message.toLowerCase().includes('version') || err.message.toLowerCase().includes('alpha'),
      'beta prerelease must be rejected'
    );

    // spaces in version
    assert.throws(
      () => planUpdate({ ...base09, version: '1. 0.0' }),
      (err) => err.message.toLowerCase().includes('invalid') || err.message.toLowerCase().includes('version'),
      'version with spaces must be rejected'
    );
  });

  // ========== R3: Filesystem mismatch rejections ==========
  it('R3: filesystem name mismatch, lockfileVersion not 3, missing packages/root, mismatched root version: reject with all 3 bytes unchanged and no debris', async () => {
    const r3Tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vu-test-'));
    try {
      await setupTmpDir(r3Tmp);
      const before = await readThree(r3Tmp);

      // 1) name mismatch: lock name differs from package name
      const lockNameMismatch = JSON.parse(before.packageLockJson);
      lockNameMismatch.name = 'other-name';
      await fs.promises.writeFile(path.join(r3Tmp, 'package-lock.json'), JSON.stringify(lockNameMismatch, null, 2), 'utf8');
      await assert.rejects(
        async () => updateVersion({
          root: r3Tmp,
          version: '0.2.0-alpha.1',
          notes: makeNotes(),
          now: makeNow(),
          dryRun: false,
          expectPlan: 'any-hash',
        }),
        (err) => err.message.toLowerCase().includes('mismatch') || err.message.toLowerCase().includes('name') || err.message.toLowerCase().includes('lock'),
        'lock name mismatch must be rejected'
      );
      let after = await readThree(r3Tmp);
      assert.strictEqual(after.packageJson, before.packageJson);
      assert.strictEqual(after.packageLockJson, JSON.stringify(lockNameMismatch, null, 2));
      assert.strictEqual(after.changelogMd, before.changelogMd);
      let debris = await listTmpDebris(r3Tmp);
      assert.deepStrictEqual(debris, [], 'no temp debris after name mismatch rejection');

      // Restore
      await fs.promises.writeFile(path.join(r3Tmp, 'package-lock.json'), before.packageLockJson, 'utf8');

      // 2) lockfileVersion not 3
      const lockBadVer = JSON.parse(before.packageLockJson);
      lockBadVer.lockfileVersion = 2;
      await fs.promises.writeFile(path.join(r3Tmp, 'package-lock.json'), JSON.stringify(lockBadVer, null, 2), 'utf8');
      await assert.rejects(
        async () => updateVersion({
          root: r3Tmp,
          version: '0.2.0-alpha.1',
          notes: makeNotes(),
          now: makeNow(),
          dryRun: false,
          expectPlan: 'any-hash',
        }),
        (err) => err.message.toLowerCase().includes('lockfileversion') || err.message.toLowerCase().includes('lock') || err.message.toLowerCase().includes('version'),
        'lockfileVersion not 3 must be rejected'
      );
      after = await readThree(r3Tmp);
      assert.strictEqual(after.packageJson, before.packageJson);
      assert.strictEqual(after.packageLockJson, JSON.stringify(lockBadVer, null, 2));
      assert.strictEqual(after.changelogMd, before.changelogMd);
      debris = await listTmpDebris(r3Tmp);
      assert.deepStrictEqual(debris, [], 'no temp debris after lockfileVersion rejection');

      // Restore
      await fs.promises.writeFile(path.join(r3Tmp, 'package-lock.json'), before.packageLockJson, 'utf8');

      // 3) missing packages/root
      const lockNoRoot = JSON.parse(before.packageLockJson);
      delete lockNoRoot.packages;
      await fs.promises.writeFile(path.join(r3Tmp, 'package-lock.json'), JSON.stringify(lockNoRoot, null, 2), 'utf8');
      await assert.rejects(
        async () => updateVersion({
          root: r3Tmp,
          version: '0.2.0-alpha.1',
          notes: makeNotes(),
          now: makeNow(),
          dryRun: false,
          expectPlan: 'any-hash',
        }),
        (err) => err.message.toLowerCase().includes('packages') || err.message.toLowerCase().includes('root') || err.message.toLowerCase().includes('lock'),
        'missing packages/root must be rejected'
      );
      after = await readThree(r3Tmp);
      assert.strictEqual(after.packageJson, before.packageJson);
      assert.strictEqual(after.packageLockJson, JSON.stringify(lockNoRoot, null, 2));
      assert.strictEqual(after.changelogMd, before.changelogMd);
      debris = await listTmpDebris(r3Tmp);
      assert.deepStrictEqual(debris, [], 'no temp debris after missing packages/root rejection');

      // Restore
      await fs.promises.writeFile(path.join(r3Tmp, 'package-lock.json'), before.packageLockJson, 'utf8');

      // 4) mismatched root version (lock.packages[''].version differs from lock.version)
      const lockRootVer = JSON.parse(before.packageLockJson);
      lockRootVer.packages[''].version = '9.9.9';
      await fs.promises.writeFile(path.join(r3Tmp, 'package-lock.json'), JSON.stringify(lockRootVer, null, 2), 'utf8');
      await assert.rejects(
        async () => updateVersion({
          root: r3Tmp,
          version: '0.2.0-alpha.1',
          notes: makeNotes(),
          now: makeNow(),
          dryRun: false,
          expectPlan: 'any-hash',
        }),
        (err) => err.message.toLowerCase().includes('mismatch') || err.message.toLowerCase().includes('lock') || err.message.toLowerCase().includes('inconsistent'),
        'mismatched root version must be rejected'
      );
      after = await readThree(r3Tmp);
      assert.strictEqual(after.packageJson, before.packageJson);
      assert.strictEqual(after.packageLockJson, JSON.stringify(lockRootVer, null, 2));
      assert.strictEqual(after.changelogMd, before.changelogMd);
      debris = await listTmpDebris(r3Tmp);
      assert.deepStrictEqual(debris, [], 'no temp debris after mismatched root version rejection');
    } finally {
      if (r3Tmp.startsWith(path.join(os.tmpdir(), 'vu-test-'))) {
        await fs.promises.rm(r3Tmp, { recursive: true, force: true });
      }
    }
  });

  // ========== R4: Lock raises VERSION_LOCK_HELD; do not remove someone else's lock ==========
  it('R4: existing lock raises error.code VERSION_LOCK_HELD and must not remove the lock', async () => {
    const before = await readThree(tmpDir);
    const plan = planUpdate({
      packageText: before.packageJson,
      lockText: before.packageLockJson,
      changelog: before.changelogMd,
      version: '0.2.0-alpha.1',
      notes: makeNotes(),
      now: makeNow(),
    });

    const lockDir = path.join(tmpDir, '.version-update.lock');
    await fs.promises.mkdir(lockDir);
    // Put a marker file inside to prove we do not remove it
    await fs.promises.writeFile(path.join(lockDir, 'marker.txt'), 'owned-by-another-process', 'utf8');

    let thrown;
    await assert.rejects(
      async () => updateVersion({
        root: tmpDir,
        version: '0.2.0-alpha.1',
        notes: makeNotes(),
        now: makeNow(),
        dryRun: false,
        expectPlan: plan.planHash,
      }),
      (err) => {
        thrown = err;
        return err.code === 'VERSION_LOCK_HELD';
      },
      'existing lock must raise VERSION_LOCK_HELD exactly'
    );

    // Lock directory must still exist with its contents
    const lockStillExists = await fs.promises.access(lockDir).then(() => true, () => false);
    assert.strictEqual(lockStillExists, true, 'lock directory must not be removed');
    const marker = await fs.promises.readFile(path.join(lockDir, 'marker.txt'), 'utf8');
    assert.strictEqual(marker, 'owned-by-another-process', 'lock contents must be preserved');

    // Files untouched
    const after = await readThree(tmpDir);
    assert.strictEqual(after.packageJson, before.packageJson);
    assert.strictEqual(after.packageLockJson, before.packageLockJson);
    assert.strictEqual(after.changelogMd, before.changelogMd);
  });

  // ========== R5: _beforeRename seam — peer changes CHANGELOG at index 1, expect rejection ==========
  it('R5: _beforeRename(1) peer changes CHANGELOG; expect rejection, own package write rolled back, peer unchanged, lock cleaned, no temp debris', async () => {
    const before = await readThree(tmpDir);
    const plan = planUpdate({
      packageText: before.packageJson,
      lockText: before.packageLockJson,
      changelog: before.changelogMd,
      version: '0.2.0-alpha.1',
      notes: makeNotes(),
      now: makeNow(),
    });

    let thrown;
    await assert.rejects(
      async () => updateVersion({
        root: tmpDir,
        version: '0.2.0-alpha.1',
        notes: makeNotes(),
        now: makeNow(),
        dryRun: false,
        expectPlan: plan.planHash,
        _beforeRename(index) {
          if (index === 1) {
            // Peer modifies CHANGELOG after package.json temp written but before rename
            fs.writeFileSync(path.join(tmpDir, 'CHANGELOG.md'), '# Peer tampered\n', 'utf8');
          }
        },
      }),
      (err) => {
        thrown = err;
        return err.message.toLowerCase().includes('changed') || err.message.toLowerCase().includes('peer') || err.message.toLowerCase().includes('stale') || err.message.toLowerCase().includes('during');
      },
      'peer change during apply must be rejected'
    );

    // All 3 files must be back to original bytes
    const after = await readThree(tmpDir);
    assert.strictEqual(after.packageJson, before.packageJson, 'package.json must be rolled back');
    assert.strictEqual(after.packageLockJson, before.packageLockJson, 'package-lock.json must remain original');
    assert.strictEqual(after.changelogMd, '# Peer tampered\n', 'peer CHANGELOG.md change must be kept, not overwritten');

    // Lock cleaned, no temp debris
    const debris = await listTmpDebris(tmpDir);
    assert.deepStrictEqual(debris, [], 'no lock or temp debris after rolled-back apply');
  });

  // ========== R6: peer changes package.json that helper wrote; RECOVERY_REQUIRED ==========
  it('R6: peer changes package.json after helper wrote it; error.code RECOVERY_REQUIRED, peer version preserved, other own writes rolled back, lock retained with manifest', async () => {
    const before = await readThree(tmpDir);
    const plan = planUpdate({
      packageText: before.packageJson,
      lockText: before.packageLockJson,
      changelog: before.changelogMd,
      version: '0.2.0-alpha.1',
      notes: makeNotes(),
      now: makeNow(),
    });

    let thrown;
    await assert.rejects(
      async () => updateVersion({
        root: tmpDir,
        version: '0.2.0-alpha.1',
        notes: makeNotes(),
        now: makeNow(),
        dryRun: false,
        expectPlan: plan.planHash,
        _beforeRename(index) {
          if (index === 2) {
            // After package.json and lock are renamed, peer changes package.json before CHANGELOG rename
            fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'fixture', version: '99.99.99' }, null, 2), 'utf8');
          }
        },
      }),
      (err) => {
        thrown = err;
        return err.code === 'RECOVERY_REQUIRED';
      },
      'peer change after rename must raise RECOVERY_REQUIRED'
    );

    assert.ok(thrown, 'error must be thrown');
    assert.strictEqual(thrown.code, 'RECOVERY_REQUIRED', 'error.code must be RECOVERY_REQUIRED');
    assert.ok(thrown.cause, 'error must have a cause');

    // Peer version must be preserved (not overwritten by rollback)
    const after = await readThree(tmpDir);
    const pkg = JSON.parse(after.packageJson);
    assert.strictEqual(pkg.version, '99.99.99', 'peer version must be preserved');

    // Other own writes rolled back (lock and changelog must be original)
    assert.strictEqual(after.packageLockJson, before.packageLockJson, 'package-lock.json must be rolled back');
    assert.strictEqual(after.changelogMd, before.changelogMd, 'CHANGELOG.md must be rolled back');

    // Lock retained with manifest.json and originals for recovery
    const lockDir = path.join(tmpDir, '.version-update.lock');
    const lockExists = await fs.promises.access(lockDir).then(() => true, () => false);
    assert.strictEqual(lockExists, true, 'lock must be retained for recovery');
    const manifestPath = path.join(lockDir, 'manifest.json');
    const manifestRaw = await fs.promises.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestRaw);
    assert.ok(manifest.originals, 'manifest must contain originals mapping');
    assert.ok(manifest.originals['package.json'], 'manifest originals must reference package.json backup');
    const origPkgPath = path.join(lockDir, manifest.originals['package.json']);
    const origPkg = await fs.promises.readFile(origPkgPath, 'utf8');
    assert.strictEqual(origPkg, before.packageJson, 'original package.json backup must match pre-update bytes');

    // No temp debris outside lock
    const debris = await listTmpDebris(tmpDir);
    assert.deepStrictEqual(debris, ['.version-update.lock'], 'only lock dir retained, no temp files');
  });

  // ========== R7: lock containing manifest from crash causes RECOVERY_REQUIRED, no mutations ==========
  it('R7: lock containing manifest from previous crash causes RECOVERY_REQUIRED and leaves all bytes untouched', async () => {
    const original = await readThree(tmpDir);

    // Simulate crash residue: lock dir with a realistic manifest.json and all original backups
    const lockDir = path.join(tmpDir, '.version-update.lock');
    await fs.promises.mkdir(lockDir);
    const manifestText = JSON.stringify({
      version: '0.2.0-alpha.1', previousVersion: '0.1.0', dateWIB: '2026-10-25',
      originals: { 'package.json': 'package.json.orig', 'package-lock.json': 'package-lock.json.orig', 'CHANGELOG.md': 'CHANGELOG.md.orig' },
    }, null, 2) + '\n';
    await fs.promises.writeFile(path.join(lockDir, 'manifest.json'), manifestText, 'utf8');
    await fs.promises.writeFile(path.join(lockDir, 'package.json.orig'), original.packageJson, 'utf8');
    await fs.promises.writeFile(path.join(lockDir, 'package-lock.json.orig'), original.packageLockJson, 'utf8');
    await fs.promises.writeFile(path.join(lockDir, 'CHANGELOG.md.orig'), original.changelogMd, 'utf8');

    // Mid-crash mix: package.json already bumped, lock still 0.1.0; the lock check must run before version validation
    await fs.promises.writeFile(path.join(tmpDir, 'package.json'), makeFixturePackage('0.2.0-alpha.1'), 'utf8');
    const before = await readThree(tmpDir);

    await assert.rejects(
      async () => updateVersion({
        root: tmpDir,
        version: '0.2.0-alpha.1',
        notes: makeNotes(),
        now: makeNow(),
        dryRun: false,
        expectPlan: 'any-hash',
      }),
      (err) => err.code === 'RECOVERY_REQUIRED',
      'crash residue lock with manifest must raise RECOVERY_REQUIRED exactly'
    );

    // All bytes untouched
    const after = await readThree(tmpDir);
    assert.strictEqual(after.packageJson, before.packageJson);
    assert.strictEqual(after.packageLockJson, before.packageLockJson);
    assert.strictEqual(after.changelogMd, before.changelogMd);

    // Recovery contract: crash residue (manifest and backups) must be byte-identical after the call
    assert.strictEqual(await fs.promises.readFile(path.join(lockDir, 'manifest.json'), 'utf8'), manifestText, 'manifest.json must not be rewritten');
    assert.strictEqual(await fs.promises.readFile(path.join(lockDir, 'package.json.orig'), 'utf8'), original.packageJson, 'package.json.orig must be unchanged');
    assert.strictEqual(await fs.promises.readFile(path.join(lockDir, 'package-lock.json.orig'), 'utf8'), original.packageLockJson, 'package-lock.json.orig must be unchanged');
    assert.strictEqual(await fs.promises.readFile(path.join(lockDir, 'CHANGELOG.md.orig'), 'utf8'), original.changelogMd, 'CHANGELOG.md.orig must be unchanged');
  });

  // ========== R8: normal apply preserves dependencies and changelog prefix; no broad reformat ==========
  it('R8: normal apply only changes version fields and preserves dependencies, lockfileVersion, and changelog prefix', async () => {
    const before = await readThree(tmpDir);
    const plan = planUpdate({
      packageText: before.packageJson,
      lockText: before.packageLockJson,
      changelog: before.changelogMd,
      version: '0.2.0-alpha.1',
      notes: makeNotes(),
      now: makeNow(),
    });

    await updateVersion({
      root: tmpDir,
      version: '0.2.0-alpha.1',
      notes: makeNotes(),
      now: makeNow(),
      dryRun: false,
      expectPlan: plan.planHash,
    });

    const after = await readThree(tmpDir);
    const pkgBefore = JSON.parse(before.packageJson);
    const pkgAfter = JSON.parse(after.packageJson);
    const lockBefore = JSON.parse(before.packageLockJson);
    const lockAfter = JSON.parse(after.packageLockJson);

    // Only version fields changed
    assert.strictEqual(pkgAfter.version, '0.2.0-alpha.1');
    assert.deepStrictEqual(pkgAfter.dependencies, pkgBefore.dependencies);
    assert.strictEqual(lockAfter.version, '0.2.0-alpha.1');
    assert.strictEqual(lockAfter.lockfileVersion, lockBefore.lockfileVersion);
    assert.deepStrictEqual(lockAfter.packages[''].dependencies, lockBefore.packages[''].dependencies);

    // Changelog prefix preserved
    assert.ok(after.changelogMd.startsWith('# Changelog\n'), 'changelog title prefix must be preserved');
  });

  // ========== R9: WHY: prefix required in notes; missing WHY rejects, all bytes intact ==========
  it('R9: notes must contain at least one WHY: prefix; missing WHY rejects and leaves all bytes intact', async () => {
    const before = await readThree(tmpDir);

    // No WHY at all
    assert.throws(
      () => planUpdate({
        packageText: before.packageJson,
        lockText: before.packageLockJson,
        changelog: before.changelogMd,
        version: '0.2.0-alpha.1',
        notes: ['Add feature without WHY'],
        now: makeNow(),
      }),
      (err) => err.message.toLowerCase().includes('why') || err.message.toLowerCase().includes('note'),
      'notes without WHY must be rejected'
    );

    // Empty notes
    assert.throws(
      () => planUpdate({
        packageText: before.packageJson,
        lockText: before.packageLockJson,
        changelog: before.changelogMd,
        version: '0.2.0-alpha.1',
        notes: [],
        now: makeNow(),
      }),
      (err) => err.message.toLowerCase().includes('why') || err.message.toLowerCase().includes('note'),
      'empty notes must be rejected'
    );

    // Valid notes with WHY accepted
    assert.doesNotThrow(
      () => planUpdate({
        packageText: before.packageJson,
        lockText: before.packageLockJson,
        changelog: before.changelogMd,
        version: '0.2.0-alpha.1',
        notes: ['WHY: this is a valid reason', 'Fix bug'],
        now: makeNow(),
      }),
      'notes containing WHY must be accepted'
    );

    // Filesystem untouched after plan rejection
    const after = await readThree(tmpDir);
    assert.strictEqual(after.packageJson, before.packageJson);
    assert.strictEqual(after.packageLockJson, before.packageLockJson);
    assert.strictEqual(after.changelogMd, before.changelogMd);

    // Also test apply path: invalid notes rejected before any write
    await assert.rejects(
      async () => updateVersion({
        root: tmpDir,
        version: '0.2.0-alpha.1',
        notes: ['No WHY here'],
        now: makeNow(),
        dryRun: false,
        expectPlan: 'ignored',
      }),
      (err) => err.message.toLowerCase().includes('why') || err.message.toLowerCase().includes('note'),
      'apply with missing WHY must reject before writing'
    );

    const afterApply = await readThree(tmpDir);
    assert.strictEqual(afterApply.packageJson, before.packageJson);
    assert.strictEqual(afterApply.packageLockJson, before.packageLockJson);
    assert.strictEqual(afterApply.changelogMd, before.changelogMd);
    const debris = await listTmpDebris(tmpDir);
    assert.deepStrictEqual(debris, [], 'no debris after WHY rejection');
  });
});
