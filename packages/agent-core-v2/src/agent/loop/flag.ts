import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const CONTENT_PROJECTION_FLAG_ID = 'context-projection';
export const CONTENT_PROJECTION_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_CONTENT_PROJECTION';

export const contentProjectionFlag: FlagDefinitionInput = {
  id: CONTENT_PROJECTION_FLAG_ID,
  title: 'Context projection (aged tool-result condensation)',
  description:
    'Once the projected request passes 60% of the model context window, condense aged oversized tool results to head/tail plus salient lines and fold repeated outputs into markers. Recent messages, the active turn, and compaction requests are never condensed; a failed invariant check discards the condensation. The model may re-run a command when it needs omitted detail.',
  env: CONTENT_PROJECTION_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(contentProjectionFlag);
