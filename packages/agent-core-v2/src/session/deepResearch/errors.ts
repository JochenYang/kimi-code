/**
 * `deepResearch` domain error codes.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const DeepResearchErrors = {
  codes: {
    INVALID_QUERY: 'deep_research.invalid_query',
    QUERY_TOO_LONG: 'deep_research.query_too_long',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(DeepResearchErrors);
