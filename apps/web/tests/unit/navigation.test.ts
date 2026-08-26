import { describe, expect, it } from 'vitest';

import { NAV_GROUPS, visibleGroups } from '@/layouts/navigation';

const allItems = NAV_GROUPS.flatMap((group) => group.items);

describe('navigation model', () => {
  it('requires a permission on every item, so nothing is visible by default', () => {
    for (const item of allItems) {
      expect(item.permission).toMatch(/^[a-z_]+:[a-z_]+$/);
    }
  });

  it('routes to each destination exactly once', () => {
    const routes = allItems.map((item) => item.to);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it('labels every item in sentence case, not a route fragment', () => {
    for (const item of allItems) {
      expect(item.label).toBeTruthy();
      expect(item.label).not.toMatch(/[/_]/);
    }
  });
});

describe('visibleGroups', () => {
  it('shows nothing at all to a principal with no permissions', () => {
    expect(visibleGroups(new Set())).toEqual([]);
  });

  it('drops a group entirely once all of its items are filtered out', () => {
    const groups = visibleGroups(new Set(['intake:view']));
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe('Intake');
    expect(groups[0]?.items.map((item) => item.to)).toEqual(['/intake']);
  });

  it('reveals only the items the permission set covers', () => {
    const groups = visibleGroups(new Set(['invoice:view', 'approval:view']));
    const routes = groups.flatMap((group) => group.items.map((item) => item.to));
    expect(routes).toEqual(['/invoices', '/approvals']);
  });

  it('keeps declaration order so the sidebar does not reshuffle per user', () => {
    const everything = new Set(allItems.map((item) => item.permission));
    expect(visibleGroups(everything).map((group) => group.label)).toEqual(
      NAV_GROUPS.map((group) => group.label),
    );
  });

  it('does not mutate the shared navigation model while filtering', () => {
    const before = NAV_GROUPS.map((group) => group.items.length);
    visibleGroups(new Set(['intake:view']));
    expect(NAV_GROUPS.map((group) => group.items.length)).toEqual(before);
  });
});
