import { buildError, buildSuccess, type ToolResponse } from '../envelope.js';
import type { IfcService, SendIfcMessageArgs } from '../ifc.js';

export async function handleSendIfcMessage(
  args: SendIfcMessageArgs,
  ifcService?: IfcService,
): Promise<ToolResponse<unknown>> {
  if (!ifcService) {
    return buildError('PRECONDITION_FAILED', 'IFC support is not configured for this server.');
  }
  try {
    return buildSuccess('COMPLETE', await ifcService.sendMessage(args));
  } catch (error) {
    return buildError(
      'PRECONDITION_FAILED',
      error instanceof Error ? error.message : String(error),
    );
  }
}
