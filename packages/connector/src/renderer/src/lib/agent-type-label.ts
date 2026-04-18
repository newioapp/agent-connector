/** Map agent type to a human-readable label. */
export function agentTypeLabel(type: string): string {
  switch (type) {
    case 'kiro-cli':
      return 'Kiro CLI';
    case 'claude-code':
      return 'Claude Code';
    default:
      return 'Custom ACP';
  }
}
