#!/usr/bin/env node
/**
 * Build a macOS `.pkg` installer for the `newio` CLI (macOS only).
 *
 * Wraps the already-built SEA binary (build/sea/newio) + its native sidecar
 * (build/sea/native) into a flat installer that lays them out as:
 *   /usr/local/lib/<cmd>/<cmd>       the binary
 *   /usr/local/lib/<cmd>/native/     sharp's native sidecar
 *   /usr/local/bin/<cmd> -> ../lib/<cmd>/<cmd>   symlink on PATH
 * The binary lives under lib/ (not bin/) so its native/ sidecar sits beside it;
 * the runtime resolves sharp from native/ next to the symlink-resolved binary.
 * The daemon LaunchAgent is NOT created here — that stays a per-user action
 * (`newio daemon start`); the pkg only needs to put the command on PATH.
 *
 * Signing: a `.pkg` is signed with a **Developer ID Installer** cert (distinct
 * from the Developer ID Application cert used on the binary itself). Set
 *   NEWIO_INSTALLER_IDENTITY="Developer ID Installer: <Name> (<TeamID>)"
 * to sign. Unset → an unsigned pkg (fine for local structure validation; not
 * distributable). Notarization + stapling happen in the release workflow, after
 * signing — a pkg CAN be stapled, unlike the bare binary.
 *
 * Run a macOS SEA build first (e.g. `pnpm --filter @newio/cli run build:sea:mac`
 * or `build:sea:mac:signed`).
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  symlinkSync,
  mkdirSync,
  rmSync,
  existsSync,
  chmodSync,
  writeFileSync,
  statSync,
  readFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  throw new Error('build-pkg is macOS only (needs pkgbuild/productbuild).');
}

// Command name (and on-disk binary name). Defaults to `newio`; per-stage builds
// set NEWIO_BIN_NAME=newio-dev / newio-integ so the installed command carries
// the stage. Must match the name the SEA build produced under build/sea/.
const binName = process.env['NEWIO_BIN_NAME'] ?? 'newio';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const seaBinary = join(pkgDir, 'build', 'sea', binName);
const seaNative = join(pkgDir, 'build', 'sea', 'native');
const pkgBuildDir = join(pkgDir, 'build', 'pkg');
const pkgRoot = join(pkgBuildDir, 'root');
const componentPkg = join(pkgBuildDir, 'newio-component.pkg');

const PKG_ID = 'app.newio.cli';
const version = process.env['NEWIO_VERSION'] ?? JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
const installerIdentity = process.env['NEWIO_INSTALLER_IDENTITY']; // unset → unsigned
const finalPkg = join(pkgBuildDir, `${binName}-${version}.pkg`);

function run(cmd, args) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', cwd: pkgDir });
}

if (!existsSync(seaBinary)) {
  throw new Error(
    `SEA binary not found: ${seaBinary}. Run "pnpm --filter @newio/cli run build:sea:mac" (or build:sea:mac:signed) first.`,
  );
}
if (!existsSync(seaNative)) {
  throw new Error(
    `Native sidecar not found: ${seaNative}. The SEA build copies sharp's runtime closure here — re-run the SEA build.`,
  );
}

// 1. Stage the payload:
//      /usr/local/lib/<cmd>/<cmd>      binary
//      /usr/local/lib/<cmd>/native/    sharp sidecar
//      /usr/local/bin/<cmd> -> ../lib/<cmd>/<cmd>
rmSync(pkgBuildDir, { recursive: true, force: true });
const libDest = join(pkgRoot, 'usr', 'local', 'lib', binName);
mkdirSync(libDest, { recursive: true });
copyFileSync(seaBinary, join(libDest, binName));
chmodSync(join(libDest, binName), 0o755);
cpSync(seaNative, join(libDest, 'native'), { recursive: true });

const binDest = join(pkgRoot, 'usr', 'local', 'bin');
mkdirSync(binDest, { recursive: true });
// Relative symlink so realpath() lands in the lib dir where native/ lives.
symlinkSync(join('..', 'lib', binName, binName), join(binDest, binName));

// 2. Build the component pkg (payload → install-location /).
run('pkgbuild', [
  '--root',
  pkgRoot,
  '--identifier',
  PKG_ID,
  '--version',
  version,
  '--install-location',
  '/',
  componentPkg,
]);

// 3. Wrap in a distribution product (gives a proper installer UI) and sign it.
const distributionXml = join(pkgBuildDir, 'distribution.xml');
writeFileSync(
  distributionXml,
  `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>Newio CLI</title>
  <options customize="never" require-scripts="false" hostArchitectures="arm64,x86_64"/>
  <pkg-ref id="${PKG_ID}"/>
  <choices-outline>
    <line choice="default"><line choice="${PKG_ID}"/></line>
  </choices-outline>
  <choice id="default"/>
  <choice id="${PKG_ID}" visible="false">
    <pkg-ref id="${PKG_ID}"/>
  </choice>
  <pkg-ref id="${PKG_ID}" version="${version}" onConclusion="none">newio-component.pkg</pkg-ref>
</installer-gui-script>
`,
);

const productArgs = [
  '--distribution',
  distributionXml,
  '--package-path',
  pkgBuildDir,
  '--version',
  version,
];
if (installerIdentity) {
  productArgs.push('--sign', installerIdentity);
}
productArgs.push(finalPkg);
run('productbuild', productArgs);

if (installerIdentity) {
  run('pkgutil', ['--check-signature', finalPkg]);
}

const sizeMb = (statSync(finalPkg).size / 1024 / 1024).toFixed(1);
console.log(`\n✓ Built ${finalPkg} (${sizeMb} MB)`);
console.log(
  installerIdentity
    ? `  signed: ${installerIdentity} — notarize + staple in the release workflow.`
    : '  UNSIGNED (local structure check only). Set NEWIO_INSTALLER_IDENTITY to sign.',
);
