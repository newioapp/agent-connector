/**
 * All evaluation scenarios — aggregated from per-area files.
 */
import type { EvalScenario } from '../types.js';
import { toolUsageScenarios } from './tool-usage.js';
import { responseRelevanceScenarios } from './response-relevance.js';
import { contextUnderstandingScenarios } from './context-understanding.js';
import { privacyScenarios } from './privacy-stranger.js';
import { privacyContactScenarios } from './privacy-contacts.js';
import { privacyPeerScenarios } from './privacy-peer.js';
import { privacySharedSessionScenarios } from './privacy-with-user-consent.js';
import { promptInjectionScenarios } from './prompt-injection.js';
import { crossSessionKnowledgeScenarios } from './cross-session-knowledge.js';
import { memoryQualityScenarios } from './memory-quality.js';
import { sessionLifecycleScenarios } from './session-lifecycle.js';
import { toneAndLanguageScenarios } from './tone-and-language.js';
import { contactHandlingScenarios } from './contact-handling.js';
import { cronExecutionScenarios } from './cron-execution.js';
import { instructionFollowingScenarios } from './instruction-following.js';
import { conversationTypeScenarios } from './conversation-type.js';
import { ambiguityScenarios } from './ambiguity.js';

export const allScenarios: readonly EvalScenario[] = [
  ...contextUnderstandingScenarios,
  ...toolUsageScenarios,
  ...privacyScenarios,
  ...privacyContactScenarios,
  ...privacyPeerScenarios,
  ...privacySharedSessionScenarios,
  ...promptInjectionScenarios,
  ...responseRelevanceScenarios,
  ...crossSessionKnowledgeScenarios,
  ...memoryQualityScenarios,
  ...sessionLifecycleScenarios,
  ...toneAndLanguageScenarios,
  ...contactHandlingScenarios,
  ...cronExecutionScenarios,
  ...instructionFollowingScenarios,
  ...conversationTypeScenarios,
  ...ambiguityScenarios,
];

export {
  toolUsageScenarios,
  responseRelevanceScenarios,
  contextUnderstandingScenarios,
  privacyScenarios,
  privacyContactScenarios,
  privacyPeerScenarios,
  privacySharedSessionScenarios,
  promptInjectionScenarios,
  crossSessionKnowledgeScenarios,
  memoryQualityScenarios,
  sessionLifecycleScenarios,
  toneAndLanguageScenarios,
  contactHandlingScenarios,
  cronExecutionScenarios,
  instructionFollowingScenarios,
  conversationTypeScenarios,
  ambiguityScenarios,
};
