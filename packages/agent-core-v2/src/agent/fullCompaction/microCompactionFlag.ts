/**
 * Experimental micro-compaction flag (default off).
 *
 * Micro-compaction trims aged tool results without a full handoff rewrite.
 * Kept experimental: cache-prefix safety requires careful suffix-only mutation.
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const MICRO_COMPACTION_FLAG_ID = 'micro-compaction';
export const MICRO_COMPACTION_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION';

export const microCompactionFlag: FlagDefinitionInput = {
  id: MICRO_COMPACTION_FLAG_ID,
  title: 'Micro compaction (aged tool-result GC)',
  description:
    'When enabled, allows cache-aware suffix trimming of aged oversized tool results before full compaction. Default off; experimental only.',
  env: MICRO_COMPACTION_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(microCompactionFlag);
