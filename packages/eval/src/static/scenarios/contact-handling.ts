/**
 * Area 9: Contact Event Handling
 *
 * Does the agent make sensible decisions on contact events?
 */
import type { EvalScenario } from '../../types.js';
import { defaultSetup, alice } from './fixtures.js';

export const contactHandlingScenarios: readonly EvalScenario[] = [
  {
    id: 'contact-event-skip-text',
    name: 'Contact events produce _skip (text is discarded)',
    description: 'Agent must output _skip for contact events — text response is never delivered.',
    area: 'contact_handling',
    sessionMode: 'both',
    setup: defaultSetup,
    events: [
      {
        type: 'contact',
        events: [
          {
            type: 'contact.request_received',
            username: 'newperson',
            displayName: 'New Person',
            accountType: 'human' as const,
            note: "Let's connect!",
            timestamp: new Date().toISOString(),
          },
        ],
      },
    ],
    expectations: [{ type: 'skip', eventIndex: 0, description: 'Contact event text is discarded — must skip' }],
  },
  {
    id: 'contact-notify-owner-of-request',
    name: 'Notifies owner about incoming friend request',
    description: 'Agent should create_dm + send_message to tell the owner about a new friend request.',
    area: 'contact_handling',
    sessionMode: 'shared',
    setup: defaultSetup,
    events: [
      {
        type: 'contact',
        events: [
          {
            type: 'contact.request_received',
            username: alice.username,
            displayName: alice.displayName,
            accountType: alice.accountType,
            note: "Hi! I'd like to be friends.",
            timestamp: new Date().toISOString(),
          },
        ],
      },
    ],
    expectations: [
      { type: 'skip', eventIndex: 0, description: 'Text response is discarded' },
      { type: 'tool_called', tool: 'send_message', description: 'Agent notifies owner about the friend request' },
    ],
  },
];
