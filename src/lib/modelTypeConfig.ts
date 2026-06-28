/**
 * Centralised source of truth for model_type config directive strings and
 * their associated UI copy (tooltips, descriptions).
 *
 * These are prepended to a node's prompt source before being sent to pbt —
 * the user never types them.  pbt merges multiple config() calls, so
 * model_type and loop_over are emitted as separate lines.
 */

export const MODEL_TYPE_INFO = {
  loop: 'Iterates over each item from an upstream JSON array. Output is a combined JSON array.',
  template: 'Not processed by AI — input is passed directly as output to the next model.',
} as const;

/**
 * The fixed config line shown as a read-only preview in NodePanel, or null
 * for regular prompt nodes that have no injected config.
 */
export function modelTypeConfigLine(isTemplate: boolean, isLoop: boolean): string | null {
  if (isLoop) return `{{ config(model_type="loop") }}`;
  if (isTemplate) return `{{ config(model_type="template") }}`;
  return null;
}

/**
 * Build the full node source that pbt receives.
 * loop_over is a separate config() call so the fixed model_type line stays
 * stable regardless of whether the user has filled in loop_over.
 */
export function buildNodeSource(
  prompt: string,
  isTemplate: boolean,
  isLoop: boolean,
): string {
  const typeLine = modelTypeConfigLine(isTemplate, isLoop);
  return typeLine ? typeLine + '\n' + prompt : prompt;
}
