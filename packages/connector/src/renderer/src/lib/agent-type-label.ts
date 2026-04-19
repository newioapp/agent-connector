/** Map agent type to a human-readable label. */
export function agentTypeLabel(type: string): string {
  switch (type) {
    case 'kiro-cli':
      return 'Kiro CLI';
    case 'claude-code':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'cursor':
      return 'Cursor';
    case 'gemini':
      return 'Gemini CLI';
    default:
      return 'Custom ACP';
  }
}
