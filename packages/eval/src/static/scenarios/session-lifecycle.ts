/**
 * Area: Handoff Note Quality
 *
 * Does the agent produce useful, well-scoped handoff notes at session end?
 */
import type { EvalScenario } from '../../types.js';
import {
  defaultSetup,
  owner,
  alice,
  bob,
  ownerDmConvId,
  aliceDmConvId,
  bobDmConvId,
  teamChatConvId,
  teamChat,
  msg,
} from './fixtures.js';

export const sessionLifecycleScenarios: readonly EvalScenario[] = [
  // ─────────────────────────────────────────────────────────────────────────
  // Handoff: mid-conversation work state
  // ─────────────────────────────────────────────────────────────────────────

  {
    id: 'lifecycle-handoff-work-state',
    name: 'Handoff captures mid-conversation work state',
    description:
      'Session ends while debugging is in progress. Handoff must capture what was being worked on and where things were left off.',
    area: 'handoff_quality',
    sessionMode: 'both',
    setup: {
      ...defaultSetup,
      contacts: [{ username: alice.username, displayName: alice.displayName, accountType: 'human' }],
    },
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: aliceDmConvId,
            conversationType: 'dm',
            sender: alice,
            text: "hey!! so i'm having this super annoying bug and idk what to do anymore. basically i have a React component — UserProfile — and it re-renders infinitely when i add a useEffect. the useEffect fetches user data from /api/users/:id and then calls setUser(data), but because user is in the dependency array it just loops forever. i feel like i'm going crazy lol. i've been staring at this for an hour. do you have any ideas? i can share the code if that helps. it's in our main dashboard repo in src/components/UserProfile.tsx",
          }),
        ],
      },
      {
        type: 'message',
        messages: [
          msg({
            conversationId: aliceDmConvId,
            conversationType: 'dm',
            sender: alice,
            text: "oh yeah i tried that already actually — wrapping the setState in a useCallback. didn't help 😞 also tried useMemo on the dependency but same result. someone on stack overflow suggested using a ref to track if the fetch already happened but that felt hacky and i wasn't sure if it'd cause issues with stale data. the component is like 200 lines so there might be something else going on that i'm missing. want me to paste the relevant part? also random but do you know if there's a way to get React DevTools to show re-render counts? that might help me figure out which update is causing it",
          }),
        ],
      },
      {
        type: 'message',
        messages: [
          msg({
            conversationId: aliceDmConvId,
            conversationType: 'dm',
            sender: alice,
            text: "ooh okay that actually makes a lot of sense!! i think you're right that the object reference is changing on every render. let me try splitting the dependency to just use the userId string instead of the whole user object. gonna refactor that part real quick and see if it fixes it. i'll message you back in a bit with results! thanks so much, i've been losing my mind over this lol. brb ☕",
          }),
        ],
      },
      { type: 'session_end' },
    ],
    expectations: [
      { type: 'no_skip', eventIndex: 0, description: 'Agent responds to debug request' },
      { type: 'no_skip', eventIndex: 1, description: 'Agent continues helping' },
      {
        type: 'llm_judge',
        eventIndex: 3,
        criteria:
          "Evaluate the HANDOFF NOTE only. The handoff must describe the CURRENT STATE of work: helping Priya debug an infinite re-render in a UserProfile React component caused by object reference in useEffect dependency array. It should mention the suggested fix (using userId string instead of user object) and that Priya is testing it. Including file paths, repo names, or notes about session state (e.g., no other active conversations) is fine — these help the next session. Score 4-5 if it captures the debugging state and pending result. Score 2-3 if it's too vague to continue from.",
        minScore: 4,
        description: 'Handoff captures current work state, not just durable facts',
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Handoff: shared-mode multi-conversation state
  // ─────────────────────────────────────────────────────────────────────────

  {
    id: 'lifecycle-handoff-shared-multi-conv',
    name: 'Handoff captures state across multiple conversations in shared mode',
    description:
      'In shared mode with multiple conversations active, the handoff must capture the state of each active thread so the next session knows what was happening everywhere.',
    area: 'handoff_quality',
    sessionMode: 'shared',
    setup: {
      ...defaultSetup,
      contacts: [
        { username: alice.username, displayName: alice.displayName, accountType: 'human' },
        { username: bob.username, displayName: bob.displayName, accountType: 'human' },
      ],
      conversations: [teamChat],
    },
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: ownerDmConvId,
            conversationType: 'dm',
            sender: owner,
            text: "Hey Nova, heads up — I just told Priya the design review is on June 5th at 2pm but I'm not sure she saw it in the group chat. Can you ping her to confirm she got it? Also I need you to start thinking about our Q3 OKRs. I want to propose 'reduce p95 latency by 30%' as one of them. We can discuss details later but keep that in mind.",
          }),
        ],
      },
      {
        type: 'message',
        messages: [
          msg({
            conversationId: aliceDmConvId,
            conversationType: 'dm',
            sender: alice,
            text: "hey!! so quick question — do you remember what date we said the design review is? i can't find it in my calendar and i need to book a room. i think marcus mentioned it last week but i totally forgot 😅",
          }),
        ],
      },
      {
        type: 'message',
        messages: [
          msg({
            conversationId: teamChatConvId,
            conversationType: 'group',
            sender: bob,
            text: "@nova7x heads up, the staging deploy is failing with an OOM error. I think it's the new image processing service eating too much memory. Can you check the CloudWatch metrics for the last hour and let us know if you see anything unusual?",
            groupName: 'Team Chat',
          }),
        ],
      },
      { type: 'session_end' },
    ],
    expectations: [
      { type: 'no_skip', eventIndex: 0, description: 'Agent acknowledges owner task' },
      { type: 'no_skip', eventIndex: 1, description: 'Agent responds to Priya' },
      { type: 'no_skip', eventIndex: 2, description: 'Agent responds to staging issue' },
      {
        type: 'llm_judge',
        eventIndex: 3,
        context:
          'Username mappings: marcus42 = Marcus Chen (owner), priya7k = Priya Kapoor (contact), jleon88 = Jorge León (contact). This is a shared-mode session that handled messages across 3 conversations.',
        criteria:
          "Evaluate the HANDOFF NOTE only (not memory facts). The handoff must capture the state of multiple active threads from this session. It should convey what happened in each conversation, what was resolved, and what remains pending or needs follow-up. Specifically: (1) Owner asked to ping Priya about design review (June 5th 2pm) and mentioned Q3 OKR ideas (p95 latency reduction) — what's the status of each? (2) Priya's question about the design review date — was it answered or still pending? (3) Jorge's staging OOM report in Team Chat — was it resolved or still open? A good handoff gives the next session enough context to continue seamlessly without re-reading message history. It should NOT just list durable facts — it must convey active state and pending items.",
        minScore: 4,
        description: 'Handoff captures multi-conversation state with pending tasks',
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Handoff: doesn't repeat saved memory facts
  // ─────────────────────────────────────────────────────────────────────────

  {
    id: 'lifecycle-handoff-no-memory-repeat',
    name: 'Handoff provides useful continuation context after storing memory',
    description:
      'After a conversation with many facts shared, the handoff should capture enough context (including pending tasks) for the next session to continue seamlessly.',
    area: 'handoff_quality',
    sessionMode: 'both',
    setup: {
      ...defaultSetup,
      contacts: [{ username: bob.username, displayName: bob.displayName, accountType: 'human' }],
    },
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: bobDmConvId,
            conversationType: 'dm',
            sender: bob,
            text: "hey! so big life update — i just bought a house! it's in Austin, TX. 3 bedrooms, nice backyard. we close on June 1st. also, my wife is pregnant — due in October! so yeah we needed the extra space lol. it's been a crazy month honestly, between the house hunting and all the baby prep stuff. oh and work has been insane too, i'm leading the migration to Kubernetes at my company now. like literally everything is happening at once 😂",
          }),
        ],
      },
      {
        type: 'message',
        messages: [
          msg({
            conversationId: bobDmConvId,
            conversationType: 'dm',
            sender: bob,
            text: "anyway the reason i'm messaging — can you help me think through names? my wife and i can't agree. she likes traditional Spanish names (her family is from Mexico) and i'm more open to anything but i want something that works in both English and Spanish. we don't know the gender yet btw, so need options for both. no rush, just whenever you have ideas send them my way!",
          }),
        ],
      },
      { type: 'session_end' },
    ],
    expectations: [
      { type: 'no_skip', eventIndex: 0, description: 'Agent responds to life update' },
      { type: 'no_skip', eventIndex: 1, description: 'Agent responds to name request' },
      {
        type: 'tool_called',
        tool: 'add_memory',
        description: 'Agent stores durable facts',
      },
      {
        type: 'llm_judge',
        eventIndex: 2,
        context:
          'Username mappings: jleon88 = Jorge León (human, in-contact). The agent stored durable facts about Jorge (house in Austin, wife pregnant due October, leading K8s migration) in memory during this session.',
        criteria:
          "Evaluate the HANDOFF NOTE only. The handoff should capture enough context for the next session to continue seamlessly. It must mention the active/pending thread: baby name suggestions (bilingual English/Spanish, gender unknown, wife prefers traditional Spanish names). It may also mention the life facts (house, pregnancy, K8s migration) — repeating saved facts is acceptable. Score 4-5 if the handoff captures the name discussion status and provides useful continuation context. Score 2-3 if it's too vague to continue from. Score 1 if it's empty or irrelevant.",
        minScore: 4,
        description: 'Handoff provides useful continuation context',
      },
    ],
  },
];
