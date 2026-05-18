/**
 * CLI entry point for the agent eval framework.
 *
 * Usage:
 *   pnpm eval -- --agent-type kiro-cli --model claude-sonnet-4-20250514
 *   pnpm eval -- --area tool_usage
 *   pnpm eval -- --scenario skip-dm-always-respond --runs 5
 */
import { config as loadDotenv } from 'dotenv';
import { program } from 'commander';

// Load .env (secrets like ANTHROPIC_API_KEY) into process.env
loadDotenv();
import type { EvalConfig, EvalScenario, EvalArea, ScenarioRunResult, ScenarioAggregateResult } from './types.js';
import type { AgentType, SessionMode } from '@newio/agent-engine';
import { allScenarios } from './scenarios/index.js';
import { runScenario } from './runner.js';
import { createScenarioRunnerDeps, ScenarioRunnerDeps } from './create-runner-deps.js';
import { generateTraceReport } from './trace-report.js';
import { mkdirSync } from 'fs';
import { join } from 'path';

function getenv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

program
  .name('newio-eval')
  .description('Agent evaluation framework for Newio agent-engine')
  .option('--agent-type <type>', 'Agent type (kiro-cli, claude-code, codex, gemini, cursor, custom)', 'kiro-cli')
  .option('--model <model>', 'Model to configure on ACP session', 'claude-sonnet-4-20250514')
  .option('--models <models>', 'Comma-separated list of models to test (overrides --model)')
  .option('--prompt-version <version>', 'Prompt formatter version', '1.0.0')
  .option('--session-mode <mode>', 'Session mode (isolated, shared, both)', 'both')
  .option('--area <area>', 'Filter by evaluation area')
  .option('--scenario <id>', 'Run a single scenario by ID')
  .option('--runs <n>', 'Number of runs per scenario', '1')
  .option('--cwd <dir>', 'Working directory for the ACP agent', process.cwd())
  .option('--executable <path>', 'Path to ACP executable (overrides agent-type default)')
  .option('--timeout <ms>', 'Timeout per prompt in ms', '120000')
  .parse();

const opts = program.opts<{
  agentType: string;
  model: string;
  models?: string;
  promptVersion: string;
  sessionMode: string;
  area?: string;
  scenario?: string;
  runs: string;
  cwd: string;
  executable?: string;
  timeout: string;
}>();

async function main(): Promise<void> {
  const models = opts.models ? opts.models.split(',').map((m) => m.trim()) : [opts.model];

  const config: EvalConfig = {
    agentType: opts.agentType as AgentType,
    acp: { cwd: opts.cwd, executablePath: opts.executable },
    model: models[0] ?? opts.model,
    promptVersion: opts.promptVersion,
    sessionMode: opts.sessionMode as SessionMode,
    judgeModel: getenv('JUDGE_MODEL'),
    judgeProvider: getenv('JUDGE_PROVIDER') as 'anthropic' | 'openai',
    judgeApiKey: getenv('JUDGE_API_KEY'),
    runsPerScenario: parseInt(opts.runs, 10),
    area: opts.area as EvalArea | undefined,
    scenarioId: opts.scenario,
  };

  // Filter scenarios
  let scenarios: readonly EvalScenario[] = allScenarios;
  if (config.scenarioId) {
    scenarios = scenarios.filter((s) => s.id === config.scenarioId);
  }
  if (config.area) {
    scenarios = scenarios.filter((s) => s.area === config.area);
  }

  // Determine which session modes to run
  const modesToRun: readonly SessionMode[] =
    config.sessionMode === 'both' ? ['shared', 'isolated'] : [config.sessionMode];

  // Expand scenarios: filter by mode compatibility and create effective (scenario, mode) pairs
  type EffectiveScenario = { readonly scenario: EvalScenario; readonly effectiveMode: SessionMode };
  const effectiveScenarios: EffectiveScenario[] = [];
  for (const mode of modesToRun) {
    for (const s of scenarios) {
      if (s.sessionMode === mode || s.sessionMode === 'both') {
        effectiveScenarios.push({ scenario: s, effectiveMode: mode });
      }
    }
  }

  if (effectiveScenarios.length === 0) {
    console.error('No scenarios match the given filters.');
    process.exit(1);
  }

  console.log(`\n🧪 Newio Agent Eval`);
  console.log(`   Agent: ${config.agentType} | Models: ${models.join(', ')} | Prompt: v${config.promptVersion}`);
  console.log(`   Scenarios: ${effectiveScenarios.length} | Runs per scenario: ${config.runsPerScenario}`);
  console.log(`   Session mode: ${config.sessionMode}\n`);

  // NOTE: Full integration requires a running ACP agent.
  // For now, print the scenario plan and exit with instructions.
  console.log('📋 Scenarios to run:\n');
  for (const { scenario: s, effectiveMode } of effectiveScenarios) {
    console.log(`   [${s.area}] ${s.id} (${effectiveMode})`);
    console.log(`     ${s.description}\n`);
  }

  console.log('─'.repeat(60));

  // Run scenarios for each model
  const allResults: ScenarioAggregateResult[] = [];
  const outputDir = join(opts.cwd, 'results');
  mkdirSync(outputDir, { recursive: true });

  for (const model of models) {
    if (models.length > 1) {
      console.log(`\n${'═'.repeat(60)}`);
      console.log(` 🤖 Model: ${model}`);
      console.log('═'.repeat(60));
    }
    const modelConfig: EvalConfig = { ...config, model };
    const results = await runAllScenarios(effectiveScenarios, modelConfig);
    allResults.push(...results);
    printReport(results);

    const reportPath = generateTraceReport(results, modelConfig, outputDir);
    console.log(`📄 Trace report: ${reportPath}`);
  }

  const failed = allResults.some((r) => r.passRate < 1);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Trace printing — generates HTML report
// ---------------------------------------------------------------------------

// (moved to trace-report.ts — generates a full HTML page)

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

export function printReport(aggregates: readonly ScenarioAggregateResult[]): void {
  console.log('\n' + '═'.repeat(60));
  console.log(' EVAL RESULTS');
  console.log('═'.repeat(60) + '\n');

  let totalPassed = 0;
  let totalFailed = 0;

  for (const agg of aggregates) {
    const icon = agg.passRate === 1 ? '✅' : agg.passRate > 0 ? '⚠️' : '❌';
    const pct = (agg.passRate * 100).toFixed(0);
    const judgeStr = agg.meanJudgeScore !== undefined ? ` | Judge: ${agg.meanJudgeScore.toFixed(1)}/5` : '';
    console.log(`${icon} ${agg.scenarioId} — ${pct}% pass (${agg.runs.length} runs)${judgeStr}`);

    for (const run of agg.runs) {
      const warnings = run.assertions.filter((a) => !a.passed && a.severity === 'warning');
      const errors = run.assertions.filter((a) => !a.passed && a.severity === 'error');
      const judged = run.assertions.filter((a) => a.score !== undefined);
      for (const w of warnings) {
        console.log(`     ⚠️  ${w.reason}`);
      }
      for (const e of errors) {
        console.log(`     ❌ ${e.reason}`);
      }
      for (const j of judged) {
        const jIcon = j.passed ? '🟢' : '🔴';
        console.log(`     ${jIcon} Score ${j.score}/5 — ${j.judgeReasoning ?? ''}`);
      }
    }

    if (agg.passRate === 1) {
      totalPassed++;
    } else {
      totalFailed++;
    }
  }

  console.log('\n' + '─'.repeat(60));
  console.log(` ✅ ${totalPassed} passed | ❌ ${totalFailed} failed | Total: ${aggregates.length}`);
  console.log('─'.repeat(60) + '\n');
}

/** Run all scenarios with multiple runs, aggregate results. */
export async function runAllScenarios(
  effectiveScenarios: readonly { readonly scenario: EvalScenario; readonly effectiveMode: SessionMode }[],
  config: EvalConfig,
): Promise<readonly ScenarioAggregateResult[]> {
  const aggregates: ScenarioAggregateResult[] = [];

  for (const { scenario, effectiveMode } of effectiveScenarios) {
    const runs: ScenarioRunResult[] = [];
    const runId = scenario.sessionMode === 'both' ? `${scenario.id} [${effectiveMode}]` : scenario.id;
    console.log(`\n  Running: ${runId}...`);

    // Override config sessionMode with the effective mode for this run
    const effectiveConfig: EvalConfig = { ...config, sessionMode: effectiveMode };

    for (let i = 0; i < config.runsPerScenario; i++) {
      // Fresh ACP process + MCP server per run for full isolation

      let deps: ScenarioRunnerDeps | undefined;
      try {
        deps = await createScenarioRunnerDeps(effectiveConfig, scenario);
        const result = await runScenario(scenario, effectiveConfig, deps, i);
        runs.push(result);
        const icon = result.passed ? '✓' : '✗';
        process.stdout.write(`  ${icon}`);
      } catch (err: unknown) {
        console.error(`\n    ❌ Run ${i} failed: ${err instanceof Error ? err.message : String(err)}`);
        // Record as failed run
        runs.push({
          scenarioId: scenario.id,
          runIndex: i,
          agentType: config.agentType,
          model: config.model,
          promptVersion: config.promptVersion,
          sessionMode: effectiveMode,
          traces: [],
          assertions: [
            {
              expectation: { type: 'no_skip' },
              passed: false,
              severity: 'error' as const,
              reason: `Run failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          passed: false,
          timestamp: new Date().toISOString(),
        });
        process.stdout.write('  ✗');
      } finally {
        await deps?.teardown();
      }
    }
    console.log();

    const passRate = runs.filter((r) => r.passed).length / runs.length;
    const judgeScores = runs.flatMap((r) =>
      r.assertions.filter((a) => a.score !== undefined).map((a) => a.score as number),
    );
    aggregates.push({
      scenarioId: runId,
      scenarioName: scenario.name,
      area: scenario.area,
      runs,
      passRate,
      meanJudgeScore: judgeScores.length > 0 ? judgeScores.reduce((a, b) => a + b, 0) / judgeScores.length : undefined,
      minJudgeScore: judgeScores.length > 0 ? Math.min(...judgeScores) : undefined,
      maxJudgeScore: judgeScores.length > 0 ? Math.max(...judgeScores) : undefined,
    });
  }

  return aggregates;
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
