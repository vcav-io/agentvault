import { buildError, buildSuccess, type ToolResponse } from '../envelope.js';
import type { CreateIfcGrantArgs, IfcService } from '../ifc.js';

/**
 * Issue a recipient grant (this agent is the recipient) and deliver it to the
 * audience's A2A endpoint when one is known.
 */
export async function handleCreateIfcGrant(
  args: CreateIfcGrantArgs,
  ifcService?: IfcService,
): Promise<ToolResponse<unknown>> {
  if (!ifcService) {
    return buildError('PRECONDITION_FAILED', 'IFC support is not configured for this server.');
  }
  let created: ReturnType<IfcService['createGrant']>;
  try {
    created = ifcService.createGrant(args);
  } catch (error) {
    return buildError('INVALID_INPUT', error instanceof Error ? error.message : String(error));
  }
  const delivery = await ifcService.deliverGrant(created.grant);
  return buildSuccess('SUCCESS', { ...created, delivery });
}
