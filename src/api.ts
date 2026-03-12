import { runDagInPyScript } from './lib/pyscriptBridge';

/** Browser-side client for the PyScript pbt runtime. */

export interface DagNodePayload {
  name: string;
  source: string;
  isTemplate?: boolean;
}

export type LlmProvider = 'gemini' | 'openai' | 'anthropic';

export interface RunResponse {
  outputs: Record<string, string>;
  errors: string[];
}

/**
 * Build and run a DAG inline inside the browser's PyScript runtime.
 */
export async function runDag(
  nodes: DagNodePayload[],
  select?: string[],
  promptdata?: Record<string, string>,
  promptfiles?: Record<string, File>,
  provider: LlmProvider = 'gemini',
  apiKey?: string,
): Promise<RunResponse> {
  return runDagInPyScript({
    nodes,
    select,
    promptdata,
    promptfiles,
    provider,
    apiKey,
  });
}
