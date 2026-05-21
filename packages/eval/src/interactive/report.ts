/**
 * Battle report — generates JSON + HTML from a BattleReport.
 */
import { writeFileSync } from 'fs';
import type { BattleReport, TurnRecord, JudgeHighlight } from './types.js';

export function saveBattleReport(report: BattleReport, outDir: string): { jsonPath: string; htmlPath: string } {
  const baseName = `battle-${report.scenario.id}-${report.config.targetModel.replace(/[^a-z0-9-]/gi, '-')}-${report.timestamp.replace(/[:.]/g, '-')}`;
  const jsonPath = `${outDir}/${baseName}.json`;
  const htmlPath = `${outDir}/${baseName}.html`;

  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(htmlPath, renderHtml(report));

  return { jsonPath, htmlPath };
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderHtml(report: BattleReport): string {
  const highlightMap = new Map<number, JudgeHighlight[]>();
  for (const h of report.verdict.highlights) {
    const list = highlightMap.get(h.turnIndex) ?? [];
    list.push(h);
    highlightMap.set(h.turnIndex, list);
  }

  const turnsHtml = report.turns.map((turn) => renderTurn(turn, highlightMap.get(turn.index))).join('\n');

  const axesHtml = report.verdict.axes
    .map(
      (a) =>
        `<div class="axis"><span class="axis-name">${esc(a.name)}</span><span class="axis-score">${a.score}/10</span><p>${esc(a.rationale)}</p></div>`,
    )
    .join('\n');

  const scoreColor =
    report.verdict.overallScore >= 70 ? '#22c55e' : report.verdict.overallScore >= 40 ? '#eab308' : '#ef4444';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Battle: ${esc(report.scenario.name)}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: #e4e4e4; padding: 2rem; max-width: 900px; margin: 0 auto; }
h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
.meta { color: #888; font-size: 0.85rem; margin-bottom: 1.5rem; }
.score-badge { display: inline-block; background: ${scoreColor}; color: #000; font-weight: 700; padding: 0.25rem 0.75rem; border-radius: 4px; font-size: 1.2rem; }
.outcome { margin: 1rem 0; padding: 0.75rem; background: #1a1a1a; border-radius: 6px; border-left: 3px solid ${scoreColor}; }
.section-title { font-size: 1.1rem; margin: 1.5rem 0 0.75rem; color: #aaa; text-transform: uppercase; letter-spacing: 0.05em; font-size: 0.8rem; }
.turn { padding: 0.75rem 1rem; margin: 0.5rem 0; border-radius: 8px; }
.turn-driver { background: #1a2332; border-left: 3px solid #3b82f6; }
.turn-target { background: #1a2a1a; border-left: 3px solid #22c55e; }
.turn-header { font-size: 0.75rem; color: #888; margin-bottom: 0.25rem; }
.turn-text { white-space: pre-wrap; }
.turn-tools { font-size: 0.75rem; color: #666; margin-top: 0.25rem; }
.highlight { margin-top: 0.4rem; padding: 0.3rem 0.5rem; border-radius: 4px; font-size: 0.8rem; }
.highlight-good { background: #1a2a1a; color: #4ade80; }
.highlight-bad { background: #2a1a1a; color: #f87171; }
.highlight-critical { background: #3a1a1a; color: #ff4444; font-weight: 700; }
.axes { display: grid; gap: 0.75rem; margin: 0.75rem 0; }
.axis { background: #1a1a1a; padding: 0.75rem; border-radius: 6px; }
.axis-name { font-weight: 600; text-transform: capitalize; }
.axis-score { float: right; font-weight: 700; }
.axis p { color: #888; font-size: 0.85rem; margin-top: 0.25rem; }
.summary { background: #1a1a1a; padding: 1rem; border-radius: 6px; margin-top: 1rem; font-style: italic; color: #ccc; }
</style>
</head>
<body>
<h1>⚔️ ${esc(report.scenario.name)}</h1>
<div class="meta">
  ${esc(report.scenario.category)} • Target: ${esc(report.config.targetModel)} • Driver: ${esc(report.config.driverModel)} • ${report.config.sessionMode} mode • ${report.turns.length} turns
</div>

<span class="score-badge">${report.verdict.overallScore}/100</span>
${report.verdict.dataLeaked ? '<span class="score-badge" style="background:#ef4444;margin-left:0.5rem">DATA LEAKED</span>' : ''}

<div class="outcome">
  <strong>Outcome:</strong> ${esc(report.outcome.result)} (declared by ${report.outcome.declaredBy})<br>
  <em>${esc(report.outcome.reason)}</em>
</div>

<div class="section-title">Objective</div>
<p style="margin-bottom:1rem">${esc(report.scenario.objective)}</p>

<div class="section-title">Battle Timeline</div>
${turnsHtml}

<div class="section-title">Judge Scores</div>
<div class="axes">${axesHtml}</div>

<div class="summary">${esc(report.verdict.summary)}</div>

<div class="meta" style="margin-top:2rem">${esc(report.timestamp)}</div>
</body>
</html>`;
}

function renderTurn(turn: TurnRecord, highlights?: JudgeHighlight[]): string {
  const cls = turn.actor === 'driver' ? 'turn-driver' : 'turn-target';
  const label = turn.actor === 'driver' ? `🧑 @${turn.persona ?? 'unknown'}` : '🤖 Target Agent';
  const tools = turn.toolCalls?.length
    ? `<div class="turn-tools">Tools: ${turn.toolCalls.map((t) => t.tool).join(', ')}</div>`
    : '';
  const highlightHtml = (highlights ?? [])
    .map((h) => `<div class="highlight highlight-${h.type}">${esc(h.description)}</div>`)
    .join('');

  return `<div class="turn ${cls}">
  <div class="turn-header">${label} • ${esc(turn.conversationId.slice(0, 8))}…</div>
  <div class="turn-text">${esc(turn.text)}</div>
  ${tools}${highlightHtml}
</div>`;
}
