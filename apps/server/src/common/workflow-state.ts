/** Prisma workflow enums → API snake_case strings. */
export function toWorkflowState(status: string): string {
  return status.toLowerCase();
}

export function parseWorkflowStates(
  raw: string | string[] | undefined,
): string[] | undefined {
  if (raw == null || raw === '') return undefined;
  const values = Array.isArray(raw) ? raw : raw.split(',');
  return values.map((v) => v.trim()).filter(Boolean);
}
