import type { SearchPage } from './types';

/** A fully dated newest-first page before the boundary proves later pages are also out of range. */
export function pagePredatesStart(page: SearchPage, startDate: string | null): boolean {
  if (!startDate || !page.hits.length) return false;
  const start = Date.parse(startDate);
  if (!Number.isFinite(start)) return false;
  let newest = -Infinity;
  for (const hit of page.hits) {
    const published = Date.parse(hit.document.publishedAt ?? hit.candidate.publishedAt ?? '');
    if (!Number.isFinite(published)) return false;
    newest = Math.max(newest, published);
  }
  return newest < start;
}

/** Track every scheduled opaque cursor for one search term and reject repeats. */
export class PaginationCursorGuard {
  private readonly scheduledBySearch = new Map<string, Set<string>>();

  accepts(searchKey: string, current: string | undefined, next: string | undefined): next is string {
    if (next === undefined || next === current) return false;
    const scheduled = this.scheduledBySearch.get(searchKey) ?? new Set<string>();
    if (scheduled.has(next)) return false;
    scheduled.add(next);
    this.scheduledBySearch.set(searchKey, scheduled);
    return true;
  }
}
