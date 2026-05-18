/**
 * Area 10: Cron Execution Correctness
 *
 * Does the agent execute scheduled tasks correctly?
 */
import type { EvalScenario } from '../types.js';
import { defaultSetup, alice } from './fixtures.js';

export const cronExecutionScenarios: readonly EvalScenario[] = [
  {
    id: 'cron-sends-to-correct-target',
    name: 'Cron sends message to correct recipient',
    description: 'Cron label says "remind Priya about the meeting" — agent should call send_dm with priya7k.',
    area: 'cron_execution',
    sessionMode: 'shared',
    setup: {
      ...defaultSetup,
      contacts: [{ username: alice.username, displayName: alice.displayName, accountType: 'human' }],
    },
    events: [
      {
        type: 'cron',
        event: {
          cronId: 'cron-remind-alice',
          label: 'Remind Priya about the standup meeting at 10am',
          triggeredAt: new Date().toISOString(),
        },
      },
    ],
    expectations: [
      { type: 'skip', eventIndex: 0, description: 'Cron text is discarded' },
      {
        type: 'tool_called',
        tool: 'send_dm',
        argsContain: { username: alice.username },
        description: 'Sends reminder to Priya',
      },
    ],
  },
  {
    id: 'cron-uses-tools-and-skips',
    name: 'Cron uses tools AND outputs _skip',
    description: 'Cron events should both perform actions via tools and output _skip (text goes nowhere).',
    area: 'cron_execution',
    sessionMode: 'shared',
    setup: {
      ...defaultSetup,
      contacts: [{ username: alice.username, displayName: alice.displayName, accountType: 'human' }],
    },
    events: [
      {
        type: 'cron',
        event: {
          cronId: 'cron-daily-checkin',
          label: 'Send daily check-in message to owner',
          triggeredAt: new Date().toISOString(),
        },
      },
    ],
    expectations: [
      { type: 'skip', eventIndex: 0, description: 'Cron output is _skip' },
      { type: 'tool_called', tool: 'send_dm', description: 'Agent uses send_dm to send the check-in to owner' },
    ],
  },
];
