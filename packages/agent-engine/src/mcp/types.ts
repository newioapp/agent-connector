export type IdGetter = () => string | undefined;

/** Hook called before each MCP tool invocation. */
export type ToolCallHook = (toolName: string, args: Readonly<Record<string, unknown>>) => void;
