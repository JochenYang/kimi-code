import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const TOOL_SELECT_FLAG_ID = 'tool-select';
export const TOOL_SELECT_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_TOOL_SELECT';

export const toolSelectFlag: FlagDefinitionInput = {
  id: TOOL_SELECT_FLAG_ID,
  title: 'Tool select (progressive tool disclosure)',
  description:
    'Keep MCP tool schemas out of the immutable top-level tools[]; the model loads them on demand via the select_tools tool. Only takes effect on models whose capability catalog declares dynamically loaded tools (tool_use + dynamically_loaded_tools). After full compaction, recently used MCP tools are hot-reloaded automatically. Enable for capable models via KIMI_CODE_EXPERIMENTAL_TOOL_SELECT or [experimental].',
  env: TOOL_SELECT_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(toolSelectFlag);
