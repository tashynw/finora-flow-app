/** JSON-safe values: Prisma BigInt → string. */
export function serialize<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    ),
  ) as T;
}

export function toBigInt(value: string | number | bigint | null | undefined): bigint | null {
  if (value === null || value === undefined || value === '') return null;
  return BigInt(value);
}
