import type { RequestContext } from '@mastra/core/request-context';

/**
 * The AgentController publishes the live session selection under the
 * `controller` request-context key rather than overriding the agent config.
 * Reading it here is what makes `/mode` and `/model` in the CLI actually change
 * the model and the prompt for a run.
 *
 * Only the fields kira-code consumes are typed.
 */
export type ControllerContext = {
  session?: {
    modeId?: string | null;
    modelId?: string | null;
  };
  getSubagentModelId?: (params?: { agentType?: string }) => string | null;
};

/**
 * Agents receive a `RequestContext` instance, while workspace tool config
 * callbacks receive a plain record of the same entries. Accept both.
 */
export type RequestContextLike = RequestContext | Record<string, unknown>;

export function getControllerContext(
  requestContext?: RequestContextLike,
): ControllerContext | undefined {
  if (!requestContext) return undefined;

  const raw =
    typeof (requestContext as RequestContext).get === 'function'
      ? (requestContext as RequestContext).get('controller')
      : (requestContext as Record<string, unknown>)['controller'];

  return typeof raw === 'object' && raw !== null ? (raw as ControllerContext) : undefined;
}
