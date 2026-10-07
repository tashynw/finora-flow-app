export type PageQuery = {
  limit?: number;
  offset?: number;
  page?: number;
  pageSize?: number;
};

export function resolvePage(query: PageQuery) {
  if (query.page != null || query.pageSize != null) {
    const pageSize = Math.min(Math.max(query.pageSize ?? 25, 1), 200);
    const page = Math.max(query.page ?? 1, 1);
    return {
      take: pageSize,
      skip: (page - 1) * pageSize,
      page,
      pageSize,
    };
  }

  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const offset = Math.max(query.offset ?? 0, 0);
  return { take: limit, skip: offset, page: null, pageSize: null, limit, offset };
}
