import { buildError, buildSuccess, type ToolResponse } from '../envelope.js';
import { labelUntrustedContent, READ_IFC_UNTRUSTED_PATHS } from '../untrusted-content.js';
import type { IfcService, ReadIfcMessagesArgs } from '../ifc.js';

export async function handleReadIfcMessages(
  args: ReadIfcMessagesArgs,
  ifcService?: IfcService,
): Promise<ToolResponse<unknown>> {
  if (!ifcService) {
    return buildError('PRECONDITION_FAILED', 'IFC support is not configured for this server.');
  }
  try {
    return labelUntrustedContent(
      buildSuccess('SUCCESS', ifcService.readMessages(args)),
      READ_IFC_UNTRUSTED_PATHS,
    );
  } catch (error) {
    return buildError(
      'UNKNOWN_ERROR',
      error instanceof Error ? error.message : String(error),
    );
  }
}
