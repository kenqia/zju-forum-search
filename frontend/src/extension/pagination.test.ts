import { describe, expect, it } from 'vitest';

import { PaginationCursorGuard } from './pagination';

describe('pagination cursor progress', () => {
  it('rejects a cursor already seen earlier in the same search', () => {
    const guard = new PaginationCursorGuard();
    expect(guard.accepts('资料', undefined, 'A')).toBe(true);
    expect(guard.accepts('资料', 'A', 'B')).toBe(true);
    expect(guard.accepts('资料', 'B', 'A')).toBe(false);
  });

  it('rejects an immediately repeated opaque cursor', () => {
    const guard = new PaginationCursorGuard();
    expect(guard.accepts('资料', undefined, 'opaque')).toBe(true);
    expect(guard.accepts('资料', 'opaque', 'opaque')).toBe(false);
  });

  it('tracks cursors independently for each search term', () => {
    const guard = new PaginationCursorGuard();
    expect(guard.accepts('高数', undefined, 'A')).toBe(true);
    expect(guard.accepts('线代', undefined, 'A')).toBe(true);
  });
});
