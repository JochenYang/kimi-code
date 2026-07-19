import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { Tool } from '#/kosong/contract/tool';
import type { ToolInfo } from '#/tool/toolContract';

export const SELECT_TOOLS_TOOL_NAME = 'select_tools';

export interface ShapedToolEntry extends ToolInfo {
  readonly deferred?: true;
}

export interface LoadToolsResult {
  readonly toLoad: readonly string[];
  readonly alreadyAvailable: readonly string[];
  readonly unknown: readonly string[];
}

export interface IAgentToolSelectService {
  readonly _serviceBrand: undefined;

  enabled(): boolean;

  shapeTools(entries: readonly ToolInfo[]): readonly ShapedToolEntry[];

  shapeHistory(messages: readonly ContextMessage[]): readonly ContextMessage[];

  load(names: readonly string[]): LoadToolsResult;

  drainPendingToolSchemas(): readonly Tool[] | undefined;

  /**
   * Record that a dynamic (MCP) tool was actually invoked so post-compaction
   * hot-reload can restore its schema without a full cold discovery.
   */
  recordRecentToolUse(name: string): void;

  /**
   * Re-load schemas for recently used dynamic tools after full compaction.
   * No-op when progressive disclosure is disabled or there is nothing recent.
   */
  reloadRecentAfterCompaction(max?: number): LoadToolsResult;

  loadableToolsAnnouncement(): string | undefined;
}

export const IAgentToolSelectService: ServiceIdentifier<IAgentToolSelectService> =
  createDecorator<IAgentToolSelectService>('agentToolSelectService');
