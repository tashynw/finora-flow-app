export type CheckInStanding =
  | 'not_sent'
  | 'awaiting_vendor'
  | 'vendor_answered'
  | 'reviewed';

export function deriveCheckInStanding(input: {
  sentAt: Date | null;
  answeredAt: Date | null;
  reviewedAt: Date | null;
}): CheckInStanding {
  if (input.reviewedAt) return 'reviewed';
  if (input.answeredAt) return 'vendor_answered';
  if (input.sentAt) return 'awaiting_vendor';
  return 'not_sent';
}

export function newCorrelationTag(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}
