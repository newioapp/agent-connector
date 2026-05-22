/**
 * Trace report — generates an HTML page with full eval trace details.
 */
import { writeFileSync } from 'fs';
import { join } from 'path';
import type {
  ScenarioRunResult,
  ScenarioAggregateResult,
  EventTrace,
  ToolCallRecord,
  ScriptedEvent,
} from '../types.js';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatEventSummary(event: ScriptedEvent): string {
  switch (event.type) {
    case 'message': {
      const msgs = event.messages;
      if (msgs.length === 1) {
        const m = msgs[0];
        if (!m) {
          return '[message] (empty batch)';
        }
        const conv =
          m.conversationType === 'dm' ? 'DM' : `${m.conversationType}${m.groupName ? ` "${m.groupName}"` : ''}`;
        return `[${conv}] @${m.senderUsername ?? m.senderUserId}`;
      }
      const first = msgs[0];
      return `[${first?.conversationType ?? 'unknown'}] ${msgs.length} messages (batch)`;
    }
    case 'contact': {
      const evts = event.events;
      if (evts.length === 1) {
        const e = evts[0];
        return `[contact] ${e?.type ?? 'unknown'} from @${e?.username ?? 'unknown'}`;
      }
      return `[contact] ${evts.length} events (batch)`;
    }
    case 'cron':
      return `[cron] "${event.event.label}"`;
    case 'initialization':
      return '[initialization] system instruction + memory';
    case 'session_end':
      return '[lifecycle] session_end';
    case 'memory_update':
      return '[lifecycle] memory_update';
  }
}

function renderToolCall(tc: ToolCallRecord): string {
  const argsHtml = escapeHtml(JSON.stringify(tc.args, null, 2));
  const resultHtml =
    tc.result !== undefined
      ? `<div class="tool-result"><span class="label">Result:</span><pre>${escapeHtml(typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result, null, 2))}</pre></div>`
      : '';
  return `<div class="tool-call"><span class="tool-name">${escapeHtml(tc.tool)}</span><pre class="tool-args">${argsHtml}</pre>${resultHtml}</div>`;
}

function renderEventTrace(trace: EventTrace, mcpToolCalls: readonly ToolCallRecord[]): string {
  const skipBadge = trace.isSkip ? '<span class="badge skip">SKIP</span>' : '';
  const toolCallsHtml =
    mcpToolCalls.length > 0
      ? `<div class="section"><h4>MCP Tool Calls (${mcpToolCalls.length})</h4>${mcpToolCalls.map(renderToolCall).join('')}</div>`
      : '';

  return `
    <div class="event-trace">
      <div class="event-header">
        <span class="event-index">#${trace.eventIndex}</span>
        <span class="event-summary">${escapeHtml(formatEventSummary(trace.event))}</span>
        <span class="latency">${trace.latencyMs}ms</span>
        ${skipBadge}
      </div>
      <div class="section">
        <h4>Prompt Sent</h4>
        <pre class="prompt">${escapeHtml(trace.promptSent)}</pre>
      </div>
      ${toolCallsHtml}
      <div class="section">
        <h4>Agent Output</h4>
        <pre class="output ${trace.isSkip ? 'skip-output' : ''}">${escapeHtml(trace.agentOutput || '(empty)')}</pre>
      </div>
    </div>`;
}

function renderRunResult(result: ScenarioRunResult): string {
  const passCount = result.assertions.filter((a) => a.passed).length;
  const totalCount = result.assertions.length;
  const statusClass = result.passed ? 'passed' : 'failed';

  const assertionsHtml = result.assertions
    .map((a) => {
      const icon = a.passed ? '✅' : a.severity === 'warning' ? '⚠️' : '❌';
      const cssClass = a.passed ? 'pass' : a.severity === 'warning' ? 'warn' : 'fail';
      const desc =
        'description' in a.expectation && a.expectation.description ? a.expectation.description : a.expectation.type;
      const details = !a.passed ? `<div class="assertion-reason">${escapeHtml(a.reason)}</div>` : '';
      const score = a.score !== undefined ? `<span class="score">Score: ${a.score}/5</span>` : '';
      const judge = a.judgeReasoning ? `<div class="judge-reasoning">${escapeHtml(a.judgeReasoning)}</div>` : '';
      return `<div class="assertion ${cssClass}">${icon} ${escapeHtml(desc)} ${score}${details}${judge}</div>`;
    })
    .join('');

  // Group MCP tool calls by eventIndex for per-trace rendering
  const toolCallsByEvent = new Map<number, ToolCallRecord[]>();
  for (const tc of result.allToolCalls) {
    const idx = tc.eventIndex ?? -1;
    const arr = toolCallsByEvent.get(idx);
    if (arr) {
      arr.push(tc);
    } else {
      toolCallsByEvent.set(idx, [tc]);
    }
  }

  return `
    <div class="run-result ${statusClass}">
      <div class="run-header">
        <h3>Run ${result.runIndex} — <span class="${statusClass}">${result.passed ? 'PASSED' : 'FAILED'}</span></h3>
        <span class="meta">${result.agentType} | ${result.model} | ${result.sessionMode}</span>
      </div>
      <div class="traces">
        <h4>Event Traces</h4>
        ${result.traces.map((t) => renderEventTrace(t, toolCallsByEvent.get(t.eventIndex) ?? [])).join('')}
      </div>
      <div class="assertions-section">
        <h4>Assertions (${passCount}/${totalCount})</h4>
        ${assertionsHtml}
      </div>
    </div>`;
}

function renderScenarioAggregate(agg: ScenarioAggregateResult): string {
  const pct = (agg.passRate * 100).toFixed(0);
  const statusClass = agg.passRate === 1 ? 'passed' : agg.passRate > 0 ? 'partial' : 'failed';
  const copyData = buildCopyPayload(agg);

  return `
    <div class="scenario">
      <div class="scenario-header ${statusClass}">
        <h2>${escapeHtml(agg.scenarioId)}</h2>
        <span class="scenario-name">${escapeHtml(agg.scenarioName)}</span>
        <span class="pass-rate">${pct}% pass (${agg.runs.length} runs)</span>
        <span class="area badge">${escapeHtml(agg.area)}</span>
        <button class="copy-btn" onclick="copyScenario(this)" data-payload="${escapeHtml(JSON.stringify(copyData))}">📋 Copy</button>
      </div>
      ${agg.runs.map(renderRunResult).join('')}
    </div>`;
}

function buildCopyPayload(agg: ScenarioAggregateResult): object {
  return {
    scenario: agg.scenarioId,
    name: agg.scenarioName,
    area: agg.area,
    passRate: agg.passRate,
    runs: agg.runs.map((run) => ({
      passed: run.passed,
      traces: run.traces
        .filter((t) => t.eventIndex >= 0) // skip init
        .map((t) => {
          const mcpCalls = run.allToolCalls
            .filter((tc) => tc.eventIndex === t.eventIndex)
            .map((tc) => ({ tool: tc.tool, args: tc.args }));
          return {
            event: `#${t.eventIndex} ${formatEventSummary(t.event)}`,
            ...(t.promptSent.length < 500
              ? { prompt: t.promptSent }
              : { prompt: '[system prompt omitted — event content in event field]' }),
            ...(mcpCalls.length > 0 ? { mcpToolCalls: mcpCalls } : {}),
            agentOutput: t.agentOutput || '(empty)',
            isSkip: t.isSkip,
          };
        }),
      assertions: run.assertions.map((a) => ({
        description:
          'description' in a.expectation && a.expectation.description ? a.expectation.description : a.expectation.type,
        passed: a.passed,
        reason: a.reason,
        ...(a.score !== undefined ? { score: a.score } : {}),
        ...(a.judgeReasoning ? { judgeReasoning: a.judgeReasoning } : {}),
      })),
    })),
  };
}

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; background: #0d1117; color: #c9d1d9; padding: 24px; line-height: 1.5; }
  h1 { color: #f0f6fc; margin-bottom: 8px; }
  .meta-header { color: #8b949e; margin-bottom: 24px; font-size: 14px; }
  .scenario { border: 1px solid #30363d; border-radius: 8px; margin-bottom: 24px; overflow: hidden; }
  .scenario-header { padding: 16px 20px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .scenario-header.passed { background: #0d2818; border-bottom: 1px solid #238636; }
  .scenario-header.partial { background: #2d1b00; border-bottom: 1px solid #d29922; }
  .scenario-header.failed { background: #2d0000; border-bottom: 1px solid #f85149; }
  .scenario-header h2 { font-size: 16px; color: #f0f6fc; }
  .scenario-name { color: #8b949e; font-size: 13px; }
  .pass-rate { margin-left: auto; font-weight: 600; font-size: 13px; }
  .copy-btn { background: #21262d; border: 1px solid #30363d; color: #8b949e; padding: 4px 10px; border-radius: 6px; font-size: 12px; cursor: pointer; transition: all 0.15s; }
  .copy-btn:hover { background: #30363d; color: #c9d1d9; }
  .copy-btn.copied { background: #238636; border-color: #238636; color: #fff; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 12px; background: #30363d; color: #8b949e; }
  .badge.skip { background: #1f2d3d; color: #58a6ff; }
  .run-result { padding: 16px 20px; border-top: 1px solid #21262d; }
  .run-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
  .run-header h3 { font-size: 14px; }
  .run-header .meta { color: #8b949e; font-size: 12px; }
  .passed { color: #3fb950; }
  .failed { color: #f85149; }
  .traces h4, .assertions-section h4 { font-size: 13px; color: #8b949e; margin: 12px 0 8px; text-transform: uppercase; letter-spacing: 0.5px; }
  .event-trace { border: 1px solid #21262d; border-radius: 6px; margin-bottom: 12px; overflow: hidden; }
  .event-header { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: #161b22; border-bottom: 1px solid #21262d; font-size: 13px; }
  .event-index { font-weight: 700; color: #58a6ff; min-width: 24px; }
  .event-summary { color: #c9d1d9; }
  .latency { margin-left: auto; color: #8b949e; font-size: 11px; }
  .section { padding: 8px 12px; border-bottom: 1px solid #21262d; }
  .section:last-child { border-bottom: none; }
  .section h4 { font-size: 11px; color: #8b949e; margin-bottom: 4px; text-transform: uppercase; }
  pre { font-size: 12px; white-space: pre-wrap; word-break: break-word; background: #0d1117; padding: 8px; border-radius: 4px; max-height: 400px; overflow-y: auto; }
  .prompt { color: #8b949e; }
  .output { color: #c9d1d9; }
  .skip-output { color: #58a6ff; font-style: italic; }
  .tool-call { margin-bottom: 8px; }
  .tool-name { font-weight: 700; color: #d2a8ff; font-size: 13px; }
  .tool-args { margin-top: 4px; color: #7ee787; }
  .tool-result { margin-top: 4px; }
  .tool-result .label { font-size: 11px; color: #8b949e; }
  .tool-result pre { color: #ffa657; }
  .assertion { padding: 4px 0; font-size: 13px; }
  .assertion.warn .assertion-reason { color: #d29922; }
  .assertion-reason { color: #f85149; font-size: 12px; margin-left: 24px; margin-top: 2px; }
  .judge-reasoning { color: #8b949e; font-size: 12px; margin-left: 24px; margin-top: 2px; font-style: italic; }
  .score { font-size: 11px; color: #d29922; margin-left: 8px; }
  .summary { margin-top: 24px; padding: 16px 20px; border: 1px solid #30363d; border-radius: 8px; background: #161b22; }
  .summary h2 { font-size: 16px; color: #f0f6fc; margin-bottom: 8px; }
  .summary-stats { display: flex; gap: 24px; font-size: 14px; }
`;

/** Generate an HTML trace report and write it to disk. Returns the file path. */
export function generateTraceReport(
  aggregates: readonly ScenarioAggregateResult[],
  config: { agentType: string; model: string; promptVersion: string; sessionMode: string; scenarioId?: string },
  outputDir: string,
): string {
  const totalPassed = aggregates.filter((a) => a.passRate === 1).length;
  const totalFailed = aggregates.length - totalPassed;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Eval Trace — ${config.agentType} ${config.model} ${timestamp}</title>
  <style>${CSS}</style>
  <script>
  function copyScenario(btn) {
    const payload = JSON.parse(btn.dataset.payload);
    const text = JSON.stringify(payload, null, 2);
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = '✅ Copied';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = '📋 Copy'; btn.classList.remove('copied'); }, 2000);
    });
  }
  </script>
</head>
<body>
  <h1>🧪 Newio Agent Eval — Trace Report</h1>
  <div class="meta-header">
    ${escapeHtml(config.agentType)} | ${escapeHtml(config.model)} | prompt v${escapeHtml(config.promptVersion)} | ${escapeHtml(config.sessionMode)} mode<br>
    Generated: ${new Date().toLocaleString()}
  </div>

  ${aggregates.map(renderScenarioAggregate).join('')}

  <div class="summary">
    <h2>Summary</h2>
    <div class="summary-stats">
      <span class="passed">✅ ${totalPassed} passed</span>
      <span class="failed">❌ ${totalFailed} failed</span>
      <span>Total: ${aggregates.length} scenarios</span>
    </div>
  </div>
</body>
</html>`;

  const modelSlug = config.model.replace(/[^a-zA-Z0-9.-]/g, '_');
  const scenarioSlug = config.scenarioId ? `-${config.scenarioId.slice(0, 60)}` : '';
  const filename = `trace-${config.agentType}-${modelSlug}-${config.sessionMode}${scenarioSlug}-${timestamp}.html`;
  const filepath = join(outputDir, filename);
  writeFileSync(filepath, html, 'utf-8');
  return filepath;
}
