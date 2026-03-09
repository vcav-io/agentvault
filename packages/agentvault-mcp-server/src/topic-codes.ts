export const SUPPORTED_TOPIC_CODES = [
  'company_strategy',
  'salary_alignment',
  'acquisition_fit',
  'technical_architecture',
  'reference_check',
] as const;

export type SupportedTopicCode = (typeof SUPPORTED_TOPIC_CODES)[number];

export function listSupportedTopicCodes(): string[] {
  return [...SUPPORTED_TOPIC_CODES];
}

export function supportsTopicAlignment(): boolean {
  return SUPPORTED_TOPIC_CODES.length > 0;
}
