import { buildError, buildSuccess, type ToolResponse } from '../envelope.js';
import type { CreateIfcGrantArgs, IfcService } from '../ifc.js';

export async function handleCreateIfcGrant(
  args: CreateIfcGrantArgs,
  ifcService?: IfcService,
): Promise<ToolResponse<unknown>> {
  if (!ifcService) {
    return buildError('PRECONDITION_FAILED', 'IFC support is not configured for this server.');
  }
  try {
    return buildSuccess('SUCCESS', ifcService.createGrant(args));
  } catch (error) {
    return buildError(
      'INVALID_INPUT',
      error instanceof Error ? error.message : String(error),
    );
  }
}
