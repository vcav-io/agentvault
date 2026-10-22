import { buildError, buildSuccess, type ToolResponse } from '../envelope.js';
import type { IfcService, RevokeIfcGrantArgs } from '../ifc.js';

export async function handleRevokeIfcGrant(
  args: RevokeIfcGrantArgs,
  ifcService?: IfcService,
): Promise<ToolResponse<unknown>> {
  if (!ifcService) {
    return buildError('PRECONDITION_FAILED', 'IFC support is not configured for this server.');
  }
  try {
    return buildSuccess('SUCCESS', ifcService.revokeGrant(args));
  } catch (error) {
    return buildError('INVALID_INPUT', error instanceof Error ? error.message : String(error));
  }
}

export async function handleListIfcGrants(ifcService?: IfcService): Promise<ToolResponse<unknown>> {
  if (!ifcService) {
    return buildError('PRECONDITION_FAILED', 'IFC support is not configured for this server.');
  }
  try {
    return buildSuccess('SUCCESS', ifcService.listGrants());
  } catch (error) {
    return buildError('UNKNOWN_ERROR', error instanceof Error ? error.message : String(error));
  }
}
