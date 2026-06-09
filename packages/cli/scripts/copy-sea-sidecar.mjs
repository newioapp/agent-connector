#!/usr/bin/env node
/**
 * Copy sharp's native runtime closure into the SEA sidecar dir.
 *
 * A SEA blob can't hold a native addon — `process.dlopen` needs a real file on
 * disk. So `sharp` (and its `@img/*` bindings) are kept OUT of the SEA bundle
 * (see tsup.sea.config.ts) and instead shipped as a plain `node_modules/` tree
 * next to the binary, at:
 *
 *   build/sea/native/node_modules/
 *
 * At runtime, agent-engine's getSharp() anchors a `createRequire` at this dir
 * (resolved relative to the binary) so sharp + its deps load from here. The
 * flat npm layout is preserved on purpose: the binding's embedded rpath
 * (`@loader_path/../../sharp-libvips-<plat>/lib`) finds the sibling libvips
 * package with no patching.
 *
 * Runs natively per-arch in CI (host arch == target arch), so the matching
 * `@img/sharp-<plat>-<arch>` optionalDependency is installed and the smoke
 * test below can dlopen it. Override the target with NEWIO_SEA_PLATFORM /
 * NEWIO_SEA_ARCH if ever needed.
 */
import { createRequire } from 'node:module';
import { cpSync, mkdirSync, rmSync, statSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pkgDir = dirname(dirname(fileURLToPath(import.meta.url))); // packages/cli
const nativeDir = join(pkgDir, 'build', 'sea', 'native');
const destModules = join(nativeDir, 'node_modules');

// --- resolve the target platform/arch --------------------------------------
const platform = process.env['NEWIO_SEA_PLATFORM'] ?? (process.platform === 'darwin' ? 'darwin' : 'linux');
const arch = process.env['NEWIO_SEA_ARCH'] ?? (process.arch === 'arm64' ? 'arm64' : 'x64');

// On Linux, glibc and musl ship as distinct @img packages. Detect musl by the
// absence of a glibc runtime version in the Node process report.
function linuxLibc() {
  try {
    const report = process.report?.getReport();
    const glibc = report && typeof report === 'object' && 'header' in report ? report.header?.glibcVersionRuntime : undefined;
    return glibc ? 'linux' : 'linuxmusl';
  } catch {
    return 'linux';
  }
}
const platTag = platform === 'linux' ? linuxLibc() : platform; // 'darwin' | 'linux' | 'linuxmusl'
const pa = `${platTag}-${arch}`; // e.g. darwin-arm64, linux-x64, linuxmusl-arm64

// --- resolve the package closure -------------------------------------------
// sharp's runtime requires: @img/colour, detect-libc, semver (all from sharp's
// own context), the platform binding, and the binding's optional libvips dep.
//
// The @img/* packages restrict their `exports`, so `<name>/package.json` isn't
// always a valid subpath — some expose it as `<name>/package` instead. Try both
// and take the package root (dirname of the resolved package.json).
function resolvePkgDir(req, name) {
  for (const sub of ['package.json', 'package']) {
    try {
      return dirname(req.resolve(`${name}/${sub}`));
    } catch {
      // try the next subpath
    }
  }
  throw new Error(`could not resolve package "${name}" (tried /package.json and /package)`);
}

const sharpDir = resolvePkgDir(require, 'sharp');
const sharpRequire = createRequire(join(sharpDir, 'package.json'));

const bindingDir = resolvePkgDir(sharpRequire, `@img/sharp-${pa}`);
const bindingRequire = createRequire(join(bindingDir, 'package.json'));

/** name (as it must appear under node_modules) -> resolved package dir on disk. */
const closure = {
  sharp: sharpDir,
  'detect-libc': resolvePkgDir(sharpRequire, 'detect-libc'),
  semver: resolvePkgDir(sharpRequire, 'semver'),
  '@img/colour': resolvePkgDir(sharpRequire, '@img/colour'),
  [`@img/sharp-${pa}`]: bindingDir,
  [`@img/sharp-libvips-${pa}`]: resolvePkgDir(bindingRequire, `@img/sharp-libvips-${pa}`),
};

// --- copy (dereference pnpm symlinks into a flat tree) ----------------------
rmSync(nativeDir, { recursive: true, force: true });
mkdirSync(destModules, { recursive: true });

let totalBytes = 0;
function dirSize(dir) {
  let sum = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    sum += entry.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return sum;
}

for (const [name, src] of Object.entries(closure)) {
  const dest = join(destModules, name);
  mkdirSync(dirname(dest), { recursive: true }); // create @img/ parent for scoped pkgs
  cpSync(src, dest, { recursive: true, dereference: true });
  const bytes = dirSize(dest);
  totalBytes += bytes;
  console.log(`  + ${name}  (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
}
console.log(`✓ sidecar: ${pa} closure → native/node_modules (${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);

// --- smoke test: resolve + dlopen exactly as the runtime will --------------
// A 1x1 red PNG. Decoding it proves the binding loads and libvips links.
const RED_1X1_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const sideRequire = createRequire(join(nativeDir, 'noop.js'));
const sharp = sideRequire('sharp');
const meta = await sharp(RED_1X1_PNG).metadata();
if (meta.width !== 1 || meta.height !== 1) {
  throw new Error(`sidecar smoke test failed: unexpected metadata ${JSON.stringify(meta)}`);
}
console.log(`✓ sidecar smoke test passed (sharp ${sharp.versions?.sharp ?? '?'} decoded a 1x1 PNG)`);
