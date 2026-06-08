#!/usr/bin/env node
/**
 * Build the `newio` Single Executable Application (SEA).
 *
 * Pipeline (Node's official SEA flow + macOS code signing):
 *   1. tsup → one self-contained CommonJS bundle (build/sea/newio-sea.cjs)
 *   2. node --experimental-sea-config → SEA blob (build/sea/newio.blob)
 *   3. copy the running `node` binary → build/sea/newio (the target executable)
 *   4. macOS: strip the existing (Node.js Foundation) signature
 *   5. postject → inject the blob into the copied binary
 *   6. macOS: re-sign with hardened runtime + entitlements, under our own
 *      signing identifier so the daemon is attributed to us, not to `node`.
 *
 * Local builds default to an ad-hoc signature (`-`), which is enough to run on
 * Apple Silicon and to validate launchd attribution. For distribution, set
 *   NEWIO_SIGN_IDENTITY="Developer ID Application: <Name> (<TeamID>)"
 * and the script adds `--timestamp` for notarization-ready signatures.
 *
 * The workspace deps (@newio/agent-sdk, @newio/agent-engine) must be built
 * first — run `pnpm --filter "@newio/cli^..." run build` (or the full
 * `pnpm --filter "@newio/cli..." run build`) before this. The Release CI does.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, existsSync, chmodSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = join(pkgDir, 'build', 'sea');
const bundle = join(buildDir, 'newio-sea.cjs');
const blob = join(buildDir, 'newio.blob');
const out = join(buildDir, 'newio');

const isMac = process.platform === 'darwin';
// Sentinel the Node SEA loader scans for to locate the injected blob.
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const SIGN_IDENTITY = process.env['NEWIO_SIGN_IDENTITY'] ?? '-'; // '-' = ad-hoc
const SIGN_ID = 'app.newio.connectord';

function run(cmd, args) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', cwd: pkgDir });
}

// 1. Bundle to a single CJS file.
run('pnpm', ['exec', 'tsup', '--config', 'tsup.sea.config.ts']);
if (!existsSync(bundle)) {
  throw new Error(`Bundle not produced: ${bundle}`);
}

// 2. Generate the SEA blob from the bundle.
run(process.execPath, ['--experimental-sea-config', 'sea/sea-config.json']);

// 3. Copy the running node binary as our target executable.
mkdirSync(buildDir, { recursive: true });
rmSync(out, { force: true });
copyFileSync(process.execPath, out);
chmodSync(out, 0o755);

// 4. macOS: a Mach-O can't be modified while signed — strip the signature.
if (isMac) {
  run('codesign', ['--remove-signature', out]);
}

// 5. Inject the blob. The Mach-O segment name is required on macOS.
const postjectArgs = [out, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', FUSE];
if (isMac) {
  postjectArgs.push('--macho-segment-name', 'NODE_SEA');
}
run('pnpm', ['exec', 'postject', ...postjectArgs]);

// 6. macOS: re-sign. Injection invalidated the signature; arm64 won't run
//    unsigned. Our identifier + hardened runtime + entitlements make the daemon
//    attributable to us instead of to the Node.js Foundation `node`.
if (isMac) {
  const signArgs = [
    '--force',
    '--sign',
    SIGN_IDENTITY,
    '--identifier',
    SIGN_ID,
    '--options',
    'runtime',
    '--entitlements',
    'sea/entitlements.plist',
  ];
  if (SIGN_IDENTITY !== '-') {
    // Secure timestamp is required for notarization; needs a real cert + network.
    signArgs.push('--timestamp');
  }
  signArgs.push(out);
  run('codesign', signArgs);
  run('codesign', ['--verify', '--verbose=2', out]);
}

const sizeMb = (statSync(out).size / 1024 / 1024).toFixed(1);
console.log(`\n✓ Built ${out} (${sizeMb} MB)`);
console.log(
  SIGN_IDENTITY === '-'
    ? '  signed ad-hoc (local validation). Set NEWIO_SIGN_IDENTITY for a distributable build.'
    : `  signed: ${SIGN_IDENTITY}`,
);
