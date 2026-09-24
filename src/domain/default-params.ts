import type { PipelineParams } from './types.js';

export const DEFAULT_PARAMS: PipelineParams = {
  loopExponent: 2,
  maxIterations: 16,
  simplifyBudget: 2000,
  storeCost: '3 cycle',
  loadCost: '2 cycle',
};
