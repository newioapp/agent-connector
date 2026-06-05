/**
 * Decoders for the structured agent inputs that cross the JSON-RPC boundary.
 *
 * AddAgentInput / UpdateAgentInput arrive as untyped objects; these validate
 * each field and narrow to the engine types without `as` casts.
 */
import type { AddAgentInput, UpdateAgentInput, AgentType, SessionMode, AcpConfig } from '@newio/agent-engine';
import { RpcError } from './rpc.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const AGENT_TYPES: readonly AgentType[] = ['claude-code', 'kiro-cli', 'codex', 'cursor', 'gemini', 'custom'];
const SESSION_MODES: readonly SessionMode[] = ['isolated', 'shared'];

function str(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw RpcError.invalidParams(`Expected ${key} to be a string.`);
  }
  return value;
}

function requireStr(obj: Record<string, unknown>, key: string): string {
  const value = str(obj, key);
  if (value === undefined) {
    throw RpcError.invalidParams(`Missing required field ${key}.`);
  }
  return value;
}

function agentType(value: string): AgentType {
  const match = AGENT_TYPES.find((t) => t === value);
  if (!match) {
    throw RpcError.invalidParams(`Invalid agent type "${value}".`);
  }
  return match;
}

function sessionMode(value: string | undefined): SessionMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = SESSION_MODES.find((m) => m === value);
  if (!match) {
    throw RpcError.invalidParams(`Invalid session mode "${value}".`);
  }
  return match;
}

function stringRecord(obj: Record<string, unknown>, key: string): Record<string, string> | undefined {
  const value = obj[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw RpcError.invalidParams(`Expected ${key} to be an object.`);
  }
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string') {
      throw RpcError.invalidParams(`Expected ${key}.${k} to be a string.`);
    }
    result[k] = v;
  }
  return result;
}

function acpConfig(obj: Record<string, unknown>): AcpConfig | undefined {
  const acp = obj['acp'];
  if (acp === undefined) {
    return undefined;
  }
  if (!isRecord(acp)) {
    throw RpcError.invalidParams('Expected acp to be an object.');
  }
  const cwd = requireStr(acp, 'cwd');
  const executablePath = str(acp, 'executablePath');
  const trust = acp['kiroCliTrustAllTools'];
  if (trust !== undefined && typeof trust !== 'boolean') {
    throw RpcError.invalidParams('Expected acp.kiroCliTrustAllTools to be a boolean.');
  }
  return {
    cwd,
    ...(executablePath !== undefined ? { executablePath } : {}),
    ...(trust !== undefined ? { kiroCliTrustAllTools: trust } : {}),
  };
}

export function decodeAddAgentInput(obj: Record<string, unknown>): AddAgentInput {
  const acp = acpConfig(obj);
  const username = str(obj, 'newioUsername');
  const mode = sessionMode(str(obj, 'sessionMode'));
  const envVars = stringRecord(obj, 'envVars');
  const envVarsShell = str(obj, 'envVarsShell');
  return {
    displayName: requireStr(obj, 'displayName'),
    type: agentType(requireStr(obj, 'type')),
    ...(username !== undefined ? { newioUsername: username } : {}),
    ...(mode !== undefined ? { sessionMode: mode } : {}),
    ...(acp !== undefined ? { acp } : {}),
    ...(envVars !== undefined ? { envVars } : {}),
    ...(envVarsShell !== undefined ? { envVarsShell } : {}),
  };
}

export function decodeUpdateAgentInput(obj: Record<string, unknown>): UpdateAgentInput {
  const displayName = str(obj, 'displayName');
  const username = str(obj, 'newioUsername');
  const mode = sessionMode(str(obj, 'sessionMode'));
  const envVars = stringRecord(obj, 'envVars');
  const envVarsShell = str(obj, 'envVarsShell');
  const acp = acpConfig(obj);
  return {
    ...(displayName !== undefined ? { displayName } : {}),
    ...(username !== undefined ? { newioUsername: username } : {}),
    ...(mode !== undefined ? { sessionMode: mode } : {}),
    ...(envVars !== undefined ? { envVars } : {}),
    ...(envVarsShell !== undefined ? { envVarsShell } : {}),
    ...(acp !== undefined ? { acp } : {}),
  };
}
