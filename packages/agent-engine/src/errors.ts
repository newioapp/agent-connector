/**
 * Engine-level error types that frontends (CLI, desktop) map to remediation hints.
 *
 * The engine stays UI-neutral: it carries a machine-readable `errorCode` and a
 * plain description, and lets each frontend append the right "how to fix it"
 * guidance (e.g. CLI → `newio agent env edit`, desktop → Environment Variables tab).
 */
import type { AgentErrorCode } from './types';

/**
 * The agent could not start because its process environment is wrong — `node`
 * or the agent executable is missing from PATH, or a required variable is unset.
 * Remedied by fixing the agent's environment variables.
 */
export class InvalidEnvironmentError extends Error {
  readonly errorCode: AgentErrorCode = 'invalid_environment';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidEnvironmentError';
  }
}

/**
 * The agent could not start because its configured working directory (`acp.cwd`)
 * does not exist or is not a directory. Caught up front at spawn so a missing cwd
 * isn't misreported as a missing `node`/executable (ENOENT from the failed
 * `chdir` is byte-identical to a missing binary). Remedied by setting a valid cwd.
 */
export class InvalidWorkingDirectoryError extends Error {
  readonly errorCode: AgentErrorCode = 'invalid_working_directory';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidWorkingDirectoryError';
  }
}

/**
 * The ACP agent failed a `session/prompt` turn (e.g. a `-32603` internal error,
 * or it ended the turn in an unexpected state). Wraps the underlying rejection so
 * callers can distinguish a failure *from the agent itself* from incidental
 * failures of the surrounding turn handling (a `sendMessage` 403, a membership
 * lookup blip) and surface a user-visible "agent hit an internal error" notice
 * only for the former. The original error is preserved as `cause`.
 */
export class AgentPromptError extends Error {
  constructor(
    message: string,
    readonly cause: unknown,
  ) {
    super(message);
    this.name = 'AgentPromptError';
  }
}
