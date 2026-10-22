import { buildError, buildSuccess, type ToolResponse } from '../envelope.js';
import { labelUntrustedContent, SEND_IFC_UNTRUSTED_PATHS } from '../untrusted-content.js';
import type { IfcService, SendIfcMessageArgs } from '../ifc.js';

export async function handleSendIfcMessage(
  args: SendIfcMessageArgs,
  ifcService?: IfcService,
): Promise<ToolResponse<unknown>> {
  if (!ifcService) {
    return buildError('PRECONDITION_FAILED', 'IFC support is not configured for this server.');
  }
  try {
    return labelUntrustedContent(
      buildSuccess('COMPLETE', await ifcService.sendMessage(args)),
      SEND_IFC_UNTRUSTED_PATHS,
    );
  } catch (error) {
    return labelUntrustedContent(
      buildError('PRECONDITION_FAILED', error instanceof Error ? error.message : String(error)),
      SEND_IFC_UNTRUSTED_PATHS,
    );
  }
}
