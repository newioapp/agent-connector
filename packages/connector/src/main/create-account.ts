/**
 * Desktop-local create-account: registers a brand-new Newio agent account against
 * the connected daemon's backend, standalone in the main process (no daemon RPC,
 * no local config written). The user then adds a runner for it by username.
 */
import { AuthManager, NewioClient } from '@newio/agent-sdk';
import { Logger } from '../shared/logger';
import type { CreateAccountResult } from '../shared/ipc-api';

const log = new Logger('create-account');

export async function createAccount(
  apiBaseUrl: string,
  name: string,
  onApprovalUrl: (url: string) => void,
): Promise<CreateAccountResult> {
  const auth = new AuthManager(apiBaseUrl);
  try {
    const handle = await auth.register({ name });
    log.info(`Registered agent ${handle.agentId}; awaiting browser approval`);
    onApprovalUrl(handle.approvalUrl);

    await handle.waitForApproval();
    const client = new NewioClient({ baseUrl: apiBaseUrl, tokenProvider: auth.tokenProvider });
    const me = await client.getMe({});
    if (!me.username) {
      throw new Error('Account was created but has no username.');
    }
    log.info(`Account created: @${me.username} (${me.userId})`);
    return { username: me.username, agentId: me.userId };
  } finally {
    auth.dispose();
  }
}
