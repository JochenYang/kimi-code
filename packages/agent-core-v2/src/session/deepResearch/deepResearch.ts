import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { DeepResearchProgress, DeepResearchResult } from './types';

export interface StartDeepResearchInput {
  readonly query: string;
  readonly breadth?: number;
  readonly onProgress?: (progress: DeepResearchProgress) => void;
}

export interface ISessionDeepResearchService {
  readonly _serviceBrand: undefined;

  start(input: StartDeepResearchInput): Promise<DeepResearchResult>;
  cancel(): void;
}

export const ISessionDeepResearchService: ServiceIdentifier<ISessionDeepResearchService> =
  createDecorator<ISessionDeepResearchService>('sessionDeepResearchService');
