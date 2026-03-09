import { randomUUID } from 'node:crypto';

export type A2ATaskState = 'submitted' | 'working' | 'completed' | 'failed';

export const A2A_SEND_MESSAGE_PATH = '/a2a/send-message';
export const AGENTVAULT_PROPOSE_MEDIA_TYPE = 'application/vnd.agentvault.propose+json';
export const AGENTVAULT_ADMIT_MEDIA_TYPE = 'application/vnd.agentvault.admit+json';
export const AGENTVAULT_DENY_MEDIA_TYPE = 'application/vnd.agentvault.deny+json';
export const AGENTVAULT_SESSION_TOKENS_MEDIA_TYPE =
  'application/vnd.agentvault.session-tokens+json';
export const AGENTVAULT_CONTRACT_OFFER_PROPOSAL_MEDIA_TYPE =
  'application/vnd.agentvault.contract-offer-proposal+json';
export const AGENTVAULT_CONTRACT_OFFER_SELECTION_MEDIA_TYPE =
  'application/vnd.agentvault.contract-offer-selection+json';

interface A2AMessagePart {
  data: unknown;
  media_type: string;
}

interface A2ASendMessageRequest {
  jsonrpc: string;
  method: string;
  params?: {
    message?: {
      message_id?: string;
      role?: string;
      parts?: A2AMessagePart[];
      extensions?: string[];
    };
    configuration?: {
      accepted_output_modes?: string[];
      task_id?: string;
    };
  };
}

export function buildA2ASendMessageRequest(params: {
  mediaType: string;
  data: unknown;
  acceptedOutputModes?: string[];
  taskId?: string;
}): Record<string, unknown> {
  const configuration: Record<string, unknown> = {};
  if (params.acceptedOutputModes) {
    configuration['accepted_output_modes'] = params.acceptedOutputModes;
  }
  if (params.taskId) {
    configuration['task_id'] = params.taskId;
  }
  return {
    jsonrpc: '2.0',
    id: randomUUID(),
    method: 'SendMessage',
    params: {
      message: {
        message_id: randomUUID(),
        role: 'user',
        parts: [
          {
            data: params.data,
            media_type: params.mediaType,
          },
        ],
      },
      ...(Object.keys(configuration).length > 0 ? { configuration } : {}),
    },
  };
}

export function buildA2ATaskResponse(params: {
  mediaType: string;
  data: unknown;
  taskId?: string;
  state?: A2ATaskState;
}): Record<string, unknown> {
  return {
    id: params.taskId ?? `task-${randomUUID()}`,
    status: { state: params.state ?? 'completed' },
    history: [
      {
        role: 'agent',
        parts: [
          {
            data: params.data,
            media_type: params.mediaType,
          },
        ],
      },
    ],
  };
}

export function parseA2ASendMessagePart(
  value: unknown,
  allowedMediaTypes: string[],
): { mediaType: string; data: unknown; taskId?: string } | null {
  if (!value || typeof value !== 'object') return null;
  const request = value as A2ASendMessageRequest;
  if (request.jsonrpc !== '2.0' || request.method !== 'SendMessage') return null;
  const parts = request.params?.message?.parts;
  if (!Array.isArray(parts)) return null;
  const taskId =
    typeof request.params?.configuration?.task_id === 'string'
      ? request.params.configuration.task_id
      : undefined;
  // A2A messages may carry multiple parts; AgentVault bootstrap currently uses
  // the first allowed media type and ignores the rest.
  for (const part of parts) {
    if (
      part &&
      typeof part === 'object' &&
      typeof (part as A2AMessagePart).media_type === 'string' &&
      allowedMediaTypes.includes((part as A2AMessagePart).media_type)
    ) {
      return {
        mediaType: (part as A2AMessagePart).media_type,
        data: (part as A2AMessagePart).data,
        ...(taskId ? { taskId } : {}),
      };
    }
  }
  return null;
}

export function parseA2ATaskPart(
  value: unknown,
  allowedMediaTypes: string[],
): { mediaType: string; data: unknown; taskId?: string; taskState?: string } | null {
  if (!value || typeof value !== 'object') return null;
  const taskRecord = value as Record<string, unknown>;
  const taskId =
    typeof taskRecord['id'] === 'string' ? taskRecord['id'] : undefined;
  const statusObj = taskRecord['status'];
  const taskState =
    statusObj &&
    typeof statusObj === 'object' &&
    typeof (statusObj as Record<string, unknown>)['state'] === 'string'
      ? ((statusObj as Record<string, unknown>)['state'] as string)
      : undefined;
  const history = taskRecord['history'];
  if (!Array.isArray(history)) return null;
  for (const entry of history) {
    if (!entry || typeof entry !== 'object') continue;
    const parts = (entry as Record<string, unknown>)['parts'];
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (
        part &&
        typeof part === 'object' &&
        typeof (part as Record<string, unknown>)['media_type'] === 'string' &&
        allowedMediaTypes.includes((part as Record<string, unknown>)['media_type'] as string)
      ) {
        return {
          mediaType: (part as Record<string, unknown>)['media_type'] as string,
          data: (part as Record<string, unknown>)['data'],
          ...(taskId ? { taskId } : {}),
          ...(taskState ? { taskState } : {}),
        };
      }
    }
  }
  return null;
}
