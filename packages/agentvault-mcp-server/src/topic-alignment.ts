export interface TopicAlignmentProposal {
  alignment_id: string;
  acceptable_topic_codes: string[];
  expected_counterparty?: string;
}

export type TopicAlignmentSelectionState = 'ALIGNED' | 'NOT_ALIGNED' | 'REJECTED';

export interface TopicAlignmentSelection {
  alignment_id: string;
  state: TopicAlignmentSelectionState;
  selected_topic_code?: string;
}

function isTopicCode(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9_]+$/.test(value);
}

export function parseTopicAlignmentProposal(value: unknown): TopicAlignmentProposal | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw['alignment_id'] !== 'string' || !Array.isArray(raw['acceptable_topic_codes'])) {
    return null;
  }
  const acceptableTopicCodes: string[] = [];
  for (const code of raw['acceptable_topic_codes']) {
    if (!isTopicCode(code)) return null;
    acceptableTopicCodes.push(code);
  }
  if (acceptableTopicCodes.length === 0) return null;
  return {
    alignment_id: raw['alignment_id'],
    acceptable_topic_codes: acceptableTopicCodes,
    ...(typeof raw['expected_counterparty'] === 'string'
      ? { expected_counterparty: raw['expected_counterparty'] }
      : {}),
  };
}

export function parseTopicAlignmentSelection(value: unknown): TopicAlignmentSelection | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const state = raw['state'];
  if (
    typeof raw['alignment_id'] !== 'string' ||
    (state !== 'ALIGNED' && state !== 'NOT_ALIGNED' && state !== 'REJECTED')
  ) {
    return null;
  }
  if (state === 'ALIGNED') {
    if (!isTopicCode(raw['selected_topic_code'])) return null;
    return {
      alignment_id: raw['alignment_id'],
      state,
      selected_topic_code: raw['selected_topic_code'],
    };
  }
  return {
    alignment_id: raw['alignment_id'],
    state,
  };
}

export function selectAlignedTopic(
  proposal: TopicAlignmentProposal,
  supportedTopicCodes: string[],
  localAgentId?: string,
): TopicAlignmentSelection {
  if (
    proposal.expected_counterparty &&
    localAgentId &&
    proposal.expected_counterparty !== localAgentId
  ) {
    return {
      alignment_id: proposal.alignment_id,
      state: 'REJECTED',
    };
  }

  const supported = new Set(supportedTopicCodes);
  for (const topicCode of proposal.acceptable_topic_codes) {
    if (supported.has(topicCode)) {
      return {
        alignment_id: proposal.alignment_id,
        state: 'ALIGNED',
        selected_topic_code: topicCode,
      };
    }
  }

  return {
    alignment_id: proposal.alignment_id,
    state: 'NOT_ALIGNED',
  };
}
