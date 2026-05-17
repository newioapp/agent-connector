export type {
  EvalArea,
  EvalConfig,
  EvalScenario,
  ScriptedEvent,
  Expectation,
  ScenarioSetup,
  UserProfile,
  ConversationSetup,
  ContactSetup,
  MemorySetup,
  MemoryScope,
  MemoryFact,
  MemorySummary,
  ToolCallRecord,
  EventTrace,
  AssertionResult,
  ScenarioRunResult,
  ScenarioAggregateResult,
  EvalReport,
} from './types.js';

export { MockNewioApp, ToolInterceptor, MockMemoryStore } from './mock-environment.js';
export type { MockNewioAppOptions, MockIdentity, MockOwnerInfo, MemoryOperation } from './mock-environment.js';

export { TraceCollector } from './trace.js';

export { evaluateExpectation, evaluateRuleBasedExpectations } from './assertions.js';

export { runScenario } from './runner.js';
