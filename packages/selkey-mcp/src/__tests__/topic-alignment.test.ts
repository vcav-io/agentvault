import { describe, expect, it } from 'vitest';
import {
  parseTopicAlignmentProposal,
  parseTopicAlignmentSelection,
  selectAlignedTopic,
  type TopicAlignmentProposal,
} from '../topic-alignment.js';

describe('topic alignment', () => {
  it('selects the first initiator-preferred topic code match', () => {
    const proposal: TopicAlignmentProposal = {
      alignment_id: 'align-123',
      acceptable_topic_codes: ['salary_alignment', 'reference_check'],
    };

    expect(selectAlignedTopic(proposal, ['reference_check', 'salary_alignment'])).toEqual({
      alignment_id: 'align-123',
      state: 'ALIGNED',
      selected_topic_code: 'salary_alignment',
    });
  });

  it('returns NOT_ALIGNED when there is no overlapping topic code', () => {
    const proposal: TopicAlignmentProposal = {
      alignment_id: 'align-123',
      acceptable_topic_codes: ['salary_alignment'],
    };

    expect(selectAlignedTopic(proposal, ['technical_architecture'])).toEqual({
      alignment_id: 'align-123',
      state: 'NOT_ALIGNED',
    });
  });

  it('returns REJECTED when expected_counterparty does not match local agent id', () => {
    const proposal: TopicAlignmentProposal = {
      alignment_id: 'align-123',
      acceptable_topic_codes: ['salary_alignment'],
      expected_counterparty: 'bob-demo',
    };

    expect(selectAlignedTopic(proposal, ['salary_alignment'], 'alice-demo')).toEqual({
      alignment_id: 'align-123',
      state: 'REJECTED',
    });
  });

  it('rejects malformed proposals and selections', () => {
    expect(
      parseTopicAlignmentProposal({
        alignment_id: 'align-123',
        acceptable_topic_codes: ['salary_alignment', 'bad-code'],
      }),
    ).toBeNull();
    expect(
      parseTopicAlignmentSelection({
        alignment_id: 'align-123',
        state: 'ALIGNED',
      }),
    ).toBeNull();
  });
});
