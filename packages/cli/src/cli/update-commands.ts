/**
 * `newio update` and the passive "update available" notice.
 *
 * `newio update` forces a CDN check and, if a newer build exists, prompts to
 * install it (re-running install.sh under the hood). The passive notice runs
 * after ordinary commands: it relies on the once-per-day cache, so it surfaces a
 * single unobtrusive line at most once per day and never on a non-interactive
 * shell (scripts/pipes stay clean).
 */
import { createInterface } from 'readline';
import type { Stage } from '../paths.js';
import { stageSuffix } from '../paths.js';
import { isSeaBinary, cliCommandName } from '../sea.js';
import { checkForUpdate } from '../update/check.js';
import { applyUpdateViaInstaller } from '../update/apply.js';

export interface UpdateContext {
  readonly stage: Stage;
  readonly cdnBaseUrl: string;
  readonly currentVersion: string;
  readonly cachePath: string;
  /** How the CLI was invoked, for the correct command name in hints. */
  readonly argv0: string;
}

export interface UpdateOptions {
  /** Report status only — never prompt or install. */
  readonly check?: boolean;
  /** Install without prompting. */
  readonly yes?: boolean;
}

/** Action for `newio update`. */
export async function update(ctx: UpdateContext, options: UpdateOptions): Promise<void> {
  const cmd = cliCommandName(ctx.argv0);
  const suffix = stageSuffix(ctx.stage);

  console.log('Checking for updates…');
  const status = await checkForUpdate({
    cdnBaseUrl: ctx.cdnBaseUrl,
    currentVersion: ctx.currentVersion,
    cachePath: ctx.cachePath,
    force: true,
  });

  if (status.latestVersion === undefined) {
    console.log(`Could not reach the update server. Check your connection and try again.`);
    return;
  }
  if (!status.updateAvailable) {
    console.log(`${cmd} ${ctx.currentVersion}${suffix} is the latest version.`);
    return;
  }

  console.log(`Update available: ${ctx.currentVersion} → ${status.latestVersion}`);

  // npm-global / from-source installs can't self-replace their executable.
  if (!isSeaBinary()) {
    console.log(
      `This ${cmd} was not installed as a standalone binary, so it can't self-update.\n` +
        `Update it the way you installed it — e.g. \`npm install -g @newio/cli@latest\`, ` +
        `or re-run the install script from the docs.`,
    );
    return;
  }

  if (options.check === true) {
    console.log(`Run \`${cmd} update\` to install.`);
    return;
  }

  if (options.yes !== true) {
    const confirmed = await confirm(`Install ${status.latestVersion} now?`);
    if (!confirmed) {
      console.log(`Skipped. You'll be reminded again tomorrow, or run \`${cmd} update\` any time.`);
      return;
    }
  }

  const result = applyUpdateViaInstaller({ cdnBaseUrl: ctx.cdnBaseUrl, version: status.latestVersion });
  if (!result.applied) {
    console.error(`Update failed: ${result.error ?? 'unknown error'}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nUpdated to ${status.latestVersion}.`);
  console.log(`Restart the daemon to run the new version: \`${cmd} daemon restart\``);
}

/**
 * Print a single "update available" line after an ordinary command, at most once
 * per day. Only fires when this run actually refreshed the cache (`checkedNow`),
 * so the reminder appears once per daily check rather than on every invocation.
 * Best-effort and silent on any failure or non-interactive shell.
 */
export async function notifyIfUpdateAvailable(ctx: UpdateContext): Promise<void> {
  // Keep scripts, pipes, and the daemon service output clean.
  if (!process.stdout.isTTY) {
    return;
  }
  try {
    const status = await checkForUpdate({
      cdnBaseUrl: ctx.cdnBaseUrl,
      currentVersion: ctx.currentVersion,
      cachePath: ctx.cachePath,
    });
    if (status.checkedNow && status.updateAvailable) {
      const cmd = cliCommandName(ctx.argv0);
      console.error(
        `\nA new version of ${cmd} is available (${ctx.currentVersion} → ${status.latestVersion}). ` +
          `Run \`${cmd} update\` to install.`,
      );
    }
  } catch {
    // Never let an update check disrupt the command the user actually ran.
  }
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false; // no interactive stdin to read a yes/no from
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer: string = await new Promise((resolve) => {
      rl.question(`${question} [y/N] `, resolve);
    });
    const normalized = answer.trim().toLowerCase();
    return normalized === 'y' || normalized === 'yes';
  } finally {
    rl.close();
  }
}
