export type Role = 'assistant' | 'user';
export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export type ToolCallId = string;
export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';
export type PlanEntryPriority = 'high' | 'medium' | 'low';
export type PlanEntryStatus = 'pending' | 'in_progress' | 'completed';
/**
 * Embed a terminal created with `terminal/create` by its id.
 *
 * The terminal must be added before calling `terminal/release`.
 *
 * See protocol docs: [Terminal](https://agentclientprotocol.com/protocol/terminals)
 */
export type Terminal = {
  /**
   * The _meta property is reserved by ACP to allow clients and agents to attach additional
   * metadata to their interactions. Implementations MUST NOT make assumptions about values at
   * these keys.
   *
   * See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)
   */
  _meta?: {
    [key: string]: unknown;
  } | null;
  terminalId: string;
};
export type Diff = {
  /**
   * The _meta property is reserved by ACP to allow clients and agents to attach additional
   * metadata to their interactions. Implementations MUST NOT make assumptions about values at
   * these keys.
   *
   * See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)
   */
  _meta?: {
    [key: string]: unknown;
  } | null;
  /**
   * The new content after modification.
   */
  newText: string;
  /**
   * The original content (None for new files).
   */
  oldText?: string | null;
  /**
   * The file path being modified.
   */
  path: string;
};
export type ToolCallContent =
  | (Content & {
      type: 'content';
    })
  | (Diff & {
      type: 'diff';
    })
  | (Terminal & {
      type: 'terminal';
    });

/**
 * Optional annotations for the client. The client can use annotations to inform how objects are used or displayed
 */
export type Annotations = {
  /**
   * The _meta property is reserved by ACP to allow clients and agents to attach additional
   * metadata to their interactions. Implementations MUST NOT make assumptions about values at
   * these keys.
   *
   * See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)
   */
  _meta?: {
    [key: string]: unknown;
  } | null;
  audience?: Array<Role> | null;
  lastModified?: string | null;
  priority?: number | null;
};

/**
 * Text provided to or from an LLM.
 */
export type TextContent = {
  /**
   * The _meta property is reserved by ACP to allow clients and agents to attach additional
   * metadata to their interactions. Implementations MUST NOT make assumptions about values at
   * these keys.
   *
   * See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)
   */
  _meta?: {
    [key: string]: unknown;
  } | null;
  annotations?: Annotations | null;
  text: string;
};

export type AudioContent = {
  /**
   * The _meta property is reserved by ACP to allow clients and agents to attach additional
   * metadata to their interactions. Implementations MUST NOT make assumptions about values at
   * these keys.
   *
   * See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)
   */
  _meta?: {
    [key: string]: unknown;
  } | null;
  annotations?: Annotations | null;
  data: string;
  mimeType: string;
};
export type ResourceLink = {
  /**
   * The _meta property is reserved by ACP to allow clients and agents to attach additional
   * metadata to their interactions. Implementations MUST NOT make assumptions about values at
   * these keys.
   *
   * See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)
   */
  _meta?: {
    [key: string]: unknown;
  } | null;
  annotations?: Annotations | null;
  description?: string | null;
  mimeType?: string | null;
  name: string;
  size?: number | null;
  title?: string | null;
  uri: string;
};
/**
 * An image provided to or from an LLM.
 */
export type ImageContent = {
  /**
   * The _meta property is reserved by ACP to allow clients and agents to attach additional
   * metadata to their interactions. Implementations MUST NOT make assumptions about values at
   * these keys.
   *
   * See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)
   */
  _meta?: {
    [key: string]: unknown;
  } | null;
  annotations?: Annotations | null;
  data: string;
  mimeType: string;
  uri?: string | null;
};
export type TextResourceContents = {
  /**
   * The _meta property is reserved by ACP to allow clients and agents to attach additional
   * metadata to their interactions. Implementations MUST NOT make assumptions about values at
   * these keys.
   *
   * See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)
   */
  _meta?: {
    [key: string]: unknown;
  } | null;
  mimeType?: string | null;
  text: string;
  uri: string;
};
export type BlobResourceContents = {
  /**
   * The _meta property is reserved by ACP to allow clients and agents to attach additional
   * metadata to their interactions. Implementations MUST NOT make assumptions about values at
   * these keys.
   *
   * See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)
   */
  _meta?: {
    [key: string]: unknown;
  } | null;
  blob: string;
  mimeType?: string | null;
  uri: string;
};
export type EmbeddedResourceResource = TextResourceContents | BlobResourceContents;
export type EmbeddedResource = {
  /**
   * The _meta property is reserved by ACP to allow clients and agents to attach additional
   * metadata to their interactions. Implementations MUST NOT make assumptions about values at
   * these keys.
   *
   * See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)
   */
  _meta?: {
    [key: string]: unknown;
  } | null;
  annotations?: Annotations | null;
  resource: EmbeddedResourceResource;
};
export type ContentBlock =
  | (TextContent & {
      type: 'text';
    })
  | (ImageContent & {
      type: 'image';
    })
  | (AudioContent & {
      type: 'audio';
    })
  | (ResourceLink & {
      type: 'resource_link';
    })
  | (EmbeddedResource & {
      type: 'resource';
    });

/**
 * Standard content block (text, images, resources).
 */
export type Content = {
  /**
   * The _meta property is reserved by ACP to allow clients and agents to attach additional
   * metadata to their interactions. Implementations MUST NOT make assumptions about values at
   * these keys.
   *
   * See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)
   */
  _meta?: {
    [key: string]: unknown;
  } | null;
  /**
   * The actual content block.
   */
  content: ContentBlock;
};
/**
 * A streamed item of content
 */
export type ContentChunk = {
  /**
   * The _meta property is reserved by ACP to allow clients and agents to attach additional
   * metadata to their interactions. Implementations MUST NOT make assumptions about values at
   * these keys.
   *
   * See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)
   */
  _meta?: {
    [key: string]: unknown;
  } | null;
  /**
   * A single item of content
   */
  content: ContentBlock;
  /**
   * **UNSTABLE**
   *
   * This capability is not part of the spec yet, and may be removed or changed at any point.
   *
   * A unique identifier for the message this chunk belongs to.
   *
   * All chunks belonging to the same message share the same `messageId`.
   * A change in `messageId` indicates a new message has started.
   * Both clients and agents MUST use UUID format for message IDs.
   *
   * @experimental
   */
  messageId?: string | null;
};

export type ToolCallLocation = {
  /**
   * The _meta property is reserved by ACP to allow clients and agents to attach additional
   * metadata to their interactions. Implementations MUST NOT make assumptions about values at
   * these keys.
   *
   * See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)
   */
  _meta?: {
    [key: string]: unknown;
  } | null;
  /**
   * Optional line number within the file.
   */
  line?: number | null;
  /**
   * The file path being accessed or modified.
   */
  path: string;
};
/**
 * Represents a tool call that the language model has requested.
 *
 * Tool calls are actions that the agent executes on behalf of the language model,
 * such as reading files, executing code, or fetching data from external sources.
 *
 * See protocol docs: [Tool Calls](https://agentclientprotocol.com/protocol/tool-calls)
 */
export type ToolCall = {
  /**
   * The _meta property is reserved by ACP to allow clients and agents to attach additional
   * metadata to their interactions. Implementations MUST NOT make assumptions about values at
   * these keys.
   *
   * See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)
   */
  _meta?: {
    [key: string]: unknown;
  } | null;
  /**
   * Content produced by the tool call.
   */
  content?: Array<ToolCallContent>;
  /**
   * The category of tool being invoked.
   * Helps clients choose appropriate icons and UI treatment.
   */
  kind?: ToolKind;
  /**
   * File locations affected by this tool call.
   * Enables "follow-along" features in clients.
   */
  locations?: Array<ToolCallLocation>;
  /**
   * Raw input parameters sent to the tool.
   */
  rawInput?: unknown;
  /**
   * Raw output returned by the tool.
   */
  rawOutput?: unknown;
  /**
   * Current execution status of the tool call.
   */
  status?: ToolCallStatus;
  /**
   * Human-readable title describing what the tool is doing.
   */
  title: string;
  /**
   * Unique identifier for this tool call within the session.
   */
  toolCallId: ToolCallId;
};
/**
 * An update to an existing tool call.
 *
 * Used to report progress and results as tools execute. All fields except
 * the tool call ID are optional - only changed fields need to be included.
 *
 * See protocol docs: [Updating](https://agentclientprotocol.com/protocol/tool-calls#updating)
 */
export type ToolCallUpdate = {
  /**
   * The _meta property is reserved by ACP to allow clients and agents to attach additional
   * metadata to their interactions. Implementations MUST NOT make assumptions about values at
   * these keys.
   *
   * See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)
   */
  _meta?: {
    [key: string]: unknown;
  } | null;
  /**
   * Replace the content collection.
   */
  content?: Array<ToolCallContent> | null;
  /**
   * Update the tool kind.
   */
  kind?: ToolKind | null;
  /**
   * Replace the locations collection.
   */
  locations?: Array<ToolCallLocation> | null;
  /**
   * Update the raw input.
   */
  rawInput?: unknown;
  /**
   * Update the raw output.
   */
  rawOutput?: unknown;
  /**
   * Update the execution status.
   */
  status?: ToolCallStatus | null;
  /**
   * Update the human-readable title.
   */
  title?: string | null;
  /**
   * The ID of the tool call being updated.
   */
  toolCallId: ToolCallId;
};

export type PlanEntry = {
  /**
   * The _meta property is reserved by ACP to allow clients and agents to attach additional
   * metadata to their interactions. Implementations MUST NOT make assumptions about values at
   * these keys.
   *
   * See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)
   */
  _meta?: {
    [key: string]: unknown;
  } | null;
  /**
   * Human-readable description of what this task aims to accomplish.
   */
  content: string;
  /**
   * The relative importance of this task.
   * Used to indicate which tasks are most critical to the overall goal.
   */
  priority: PlanEntryPriority;
  /**
   * Current execution status of this task.
   */
  status: PlanEntryStatus;
};
/**
 * An execution plan for accomplishing complex tasks.
 *
 * Plans consist of multiple entries representing individual tasks or goals.
 * Agents report plans to clients to provide visibility into their execution strategy.
 * Plans can evolve during execution as the agent discovers new requirements or completes tasks.
 *
 * See protocol docs: [Agent Plan](https://agentclientprotocol.com/protocol/agent-plan)
 */
export type Plan = {
  /**
   * The _meta property is reserved by ACP to allow clients and agents to attach additional
   * metadata to their interactions. Implementations MUST NOT make assumptions about values at
   * these keys.
   *
   * See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)
   */
  _meta?: {
    [key: string]: unknown;
  } | null;
  /**
   * The list of tasks to be accomplished.
   *
   * When updating a plan, the agent must send a complete list of all entries
   * with their current status. The client replaces the entire plan with each update.
   */
  entries: Array<PlanEntry>;
};
export type SessionUpdate =
  | (ContentChunk & {
      sessionUpdate: 'user_message_chunk';
    })
  | (ContentChunk & {
      sessionUpdate: 'agent_message_chunk';
    })
  | (ContentChunk & {
      sessionUpdate: 'agent_thought_chunk';
    })
  | (ToolCall & {
      sessionUpdate: 'tool_call';
    })
  | (ToolCallUpdate & {
      sessionUpdate: 'tool_call_update';
    })
  | (Plan & {
      sessionUpdate: 'plan';
    })
  | (AvailableCommandsUpdate & {
      sessionUpdate: 'available_commands_update';
    })
  | (CurrentModeUpdate & {
      sessionUpdate: 'current_mode_update';
    })
  | (ConfigOptionUpdate & {
      sessionUpdate: 'config_option_update';
    })
  | (SessionInfoUpdate & {
      sessionUpdate: 'session_info_update';
    })
  | (UsageUpdate & {
      sessionUpdate: 'usage_update';
    });

export type SessionId = string;
export type SessionNotification = {
  /**
   * The _meta property is reserved by ACP to allow clients and agents to attach additional
   * metadata to their interactions. Implementations MUST NOT make assumptions about values at
   * these keys.
   *
   * See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)
   */
  _meta?: {
    [key: string]: unknown;
  } | null;
  /**
   * The ID of the session this update pertains to.
   */
  sessionId: SessionId;
  /**
   * The actual update content.
   */
  update: SessionUpdate;
};
