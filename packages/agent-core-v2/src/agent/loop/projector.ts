import type { ContextMessage } from '#/agent/contextMemory/types';
import type { Message } from '@moonshot-ai/core/llm/message';
import {
  applyContentProjection,
  type ContentProjectionOptions,
  type ContentProjectionStats,
} from './contentProjection';
import {
  project,
  projectStrict,
  type OnAnomaly,
  type ProjectionAnomaly,
} from './projection';

export class AgentLoopProjector {
  constructor(
    private readonly onRepair: (anomalies: readonly ProjectionAnomaly[]) => void,
    private readonly onContentProjection: (stats: ContentProjectionStats) => void,
  ) {}

  project(messages: readonly ContextMessage[], strict = false): readonly Message[] {
    return this.projectWithTrace(messages, strict ? projectStrict : project);
  }

  projectContent(
    messages: readonly Message[],
    options: ContentProjectionOptions,
  ): readonly Message[] {
    const result = applyContentProjection(messages, options);
    this.onContentProjection(result.stats);
    return result.messages;
  }

  private projectWithTrace(
    messages: readonly ContextMessage[],
    fn: (history: readonly ContextMessage[], onAnomaly?: OnAnomaly) => Message[],
  ): readonly Message[] {
    const anomalies: ProjectionAnomaly[] = [];
    const result = fn(messages, (anomaly) => anomalies.push(anomaly));
    this.onRepair(anomalies);
    return result;
  }
}
