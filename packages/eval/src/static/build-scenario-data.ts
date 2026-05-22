/**
 * Maps EvalScenario.setup (ScenarioSetup) → ScenarioData for MockBackend.loadFrom().
 */
import type { ScenarioSetup } from '../types.js';
import type { ScenarioData, ScenarioUser, ScenarioFriendship, ScenarioConversation } from '../mock-backend.js';

export function buildScenarioData(setup: ScenarioSetup): ScenarioData {
  const users: ScenarioUser[] = [];
  const friendships: ScenarioFriendship[] = [];
  const conversations: ScenarioConversation[] = [];

  // Owner
  users.push({
    userId: setup.agent.ownerId,
    username: setup.owner.username,
    displayName: setup.owner.displayName,
    accountType: 'human',
  });

  // Agent
  users.push({
    userId: setup.agent.userId,
    username: setup.agent.username,
    displayName: setup.agent.displayName,
    accountType: 'agent',
    ownerId: setup.agent.ownerId,
  });

  // Agent ↔ Owner friendship
  friendships.push({ user1: setup.agent.username, user2: setup.owner.username });

  // Contacts
  for (const c of setup.contacts ?? []) {
    const existing = users.find((u) => u.username === c.username);
    if (!existing) {
      users.push({
        username: c.username,
        displayName: c.displayName,
        accountType: c.accountType,
      });
    }
    friendships.push({ user1: setup.agent.username, user2: c.username });
  }

  // Conversation members — ensure all referenced users exist
  for (const conv of setup.conversations ?? []) {
    for (const m of conv.members) {
      const existing = users.find((u) => u.username === m.username);
      if (!existing) {
        users.push({
          userId: m.userId,
          username: m.username,
          displayName: m.displayName,
          accountType: m.accountType,
          ...(m.ownerUsername ? { ownerId: setup.agent.ownerId } : {}),
        });
      }
    }

    conversations.push({
      conversationId: conv.conversationId,
      type: conv.type,
      name: conv.name,
      members: conv.members.map((m) => ({
        username: m.username,
        role: m.relationship === 'owner' ? 'admin' : 'member',
      })),
      createdBy: setup.agent.username,
    });
  }

  // Memory store
  const memory = buildMemory(setup);

  return {
    users,
    friendships,
    conversations,
    memory: memory.length > 0 ? memory : undefined,
  };
}

function buildMemory(setup: ScenarioSetup): ScenarioData['memory'] & object {
  if (!setup.memoryStore) {
    return [];
  }

  const agentUsername = setup.agent.username;
  const userScopes: Record<string, { summary?: string; facts?: readonly { text: string }[] }> = {};
  const convScopes: Record<string, { summary?: string; facts?: readonly { text: string }[] }> = {};
  let globalScope: { summary?: string; facts?: readonly { text: string }[] } | undefined;

  for (const [key, value] of Object.entries(setup.memoryStore)) {
    const mapped = {
      ...(value.summary ? { summary: value.summary } : {}),
      ...(value.facts.length > 0 ? { facts: value.facts.map((f) => ({ text: f.text })) } : {}),
    };

    if (key === '__global__') {
      globalScope = mapped;
    } else if (setup.contacts?.some((c) => c.username === key)) {
      userScopes[key] = mapped;
    } else {
      // Assume it's a conversationId
      convScopes[key] = mapped;
    }
  }

  return [
    {
      agent: agentUsername,
      ...(globalScope ? { global: globalScope } : {}),
      ...(Object.keys(userScopes).length > 0 ? { users: userScopes } : {}),
      ...(Object.keys(convScopes).length > 0 ? { conversations: convScopes } : {}),
    },
  ];
}
