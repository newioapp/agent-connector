import { describe, it, expect } from 'vitest';
import { Params, RpcError, JsonRpcErrorCode, RPC_PROTOCOL_VERSION } from '../src/daemon/rpc';
import { decodeAddAgentInput, decodeUpdateAgentInput } from '../src/daemon/decode-agent';

describe('Params', () => {
  it('decodes required strings', () => {
    expect(new Params(['abc']).string(0, 'x')).toBe('abc');
  });

  it('throws InvalidParams for a non-string', () => {
    try {
      new Params([42]).string(0, 'x');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).code).toBe(JsonRpcErrorCode.InvalidParams);
    }
  });

  it('treats undefined/null as undefined for optional strings', () => {
    expect(new Params([]).optionalString(0, 'x')).toBeUndefined();
    expect(new Params([null]).optionalString(0, 'x')).toBeUndefined();
    expect(new Params(['v']).optionalString(0, 'x')).toBe('v');
  });

  it('validates string records', () => {
    expect(new Params([{ A: '1' }]).stringRecord(0, 'env')).toEqual({ A: '1' });
    expect(() => new Params([{ A: 1 }]).stringRecord(0, 'env')).toThrow(RpcError);
    expect(() => new Params(['nope']).stringRecord(0, 'env')).toThrow(RpcError);
  });
});

describe('RpcError', () => {
  it('methodNotFound carries the standard code', () => {
    expect(RpcError.methodNotFound('x.y').code).toBe(JsonRpcErrorCode.MethodNotFound);
  });
});

describe('decodeAddAgentInput', () => {
  it('decodes a full input', () => {
    const input = decodeAddAgentInput({
      displayName: 'Bot',
      type: 'codex',
      newioUsername: 'bot',
      sessionMode: 'shared',
      acp: { cwd: '/tmp', kiroCliTrustAllTools: true },
      envVars: { K: 'v' },
    });
    expect(input).toEqual({
      displayName: 'Bot',
      type: 'codex',
      newioUsername: 'bot',
      sessionMode: 'shared',
      acp: { cwd: '/tmp', kiroCliTrustAllTools: true },
      envVars: { K: 'v' },
    });
  });

  it('requires displayName and type', () => {
    expect(() => decodeAddAgentInput({ type: 'codex' })).toThrow('displayName');
    expect(() => decodeAddAgentInput({ displayName: 'X' })).toThrow('type');
  });

  it('rejects an invalid agent type and session mode', () => {
    expect(() => decodeAddAgentInput({ displayName: 'X', type: 'bogus' })).toThrow('Invalid agent type');
    expect(() => decodeAddAgentInput({ displayName: 'X', type: 'codex', sessionMode: 'weird' })).toThrow(
      'Invalid session mode',
    );
  });

  it('requires acp.cwd when acp is present', () => {
    expect(() => decodeAddAgentInput({ displayName: 'X', type: 'codex', acp: {} })).toThrow('cwd');
  });
});

describe('decodeUpdateAgentInput', () => {
  it('passes through only provided fields', () => {
    expect(decodeUpdateAgentInput({ displayName: 'New' })).toEqual({ displayName: 'New' });
    expect(decodeUpdateAgentInput({})).toEqual({});
  });

  it('validates session mode', () => {
    expect(() => decodeUpdateAgentInput({ sessionMode: 'weird' })).toThrow('Invalid session mode');
  });
});

describe('protocol version', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(RPC_PROTOCOL_VERSION)).toBe(true);
    expect(RPC_PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});
