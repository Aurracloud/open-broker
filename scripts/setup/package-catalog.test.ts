import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  INSTALLABLE_PACKAGES,
  packageSpec,
  resolveInstallablePackage,
} from './package-catalog.js';

const installScript = fileURLToPath(new URL('./install.ts', import.meta.url));

test('resolves companion packages by short name and npm package name', () => {
  assert.equal(resolveInstallablePackage('monitoring')?.packageName, 'openbroker-monitoring');
  assert.equal(resolveInstallablePackage('openbroker-monitoring')?.key, 'monitoring');
  assert.equal(resolveInstallablePackage('EXTENDED')?.command, 'openbroker-ex');
  assert.equal(resolveInstallablePackage('unknown'), null);
});

test('builds pinned or latest npm package specs without accepting arbitrary specs', () => {
  const monitoring = INSTALLABLE_PACKAGES.find((entry) => entry.key === 'monitoring');
  assert.ok(monitoring);
  assert.equal(packageSpec(monitoring), 'openbroker-monitoring@latest');
  assert.equal(packageSpec(monitoring, '1.4.2'), 'openbroker-monitoring@1.4.2');
  assert.throws(() => packageSpec(monitoring, 'npm:unrelated-package'));
  assert.throws(() => packageSpec(monitoring, '../local-package'));
});

test('installer dry run prints the global npm operation without writing', () => {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', installScript, 'monitoring', '--tag', '1.4.2', '--dry'],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /npm install --global openbroker-monitoring@1\.4\.2/);
  assert.match(result.stdout, /nothing was installed/i);
});

test('installer rejects packages outside the catalog', () => {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', installScript, 'unrelated-package', '--dry'],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown installable package/i);
});
