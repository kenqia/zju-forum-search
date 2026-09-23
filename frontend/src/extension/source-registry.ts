import { duoAdapter } from './sites/duo';
import { cc98Adapter } from './sites/cc98';
import type { SearchSourceAdapter } from './types';

const adapters: readonly SearchSourceAdapter[] = [cc98Adapter, duoAdapter];

export const sourceRegistry = {
  adapters,
  resolve(pageUrl: string): SearchSourceAdapter | undefined {
    let url: URL;
    try { url = new URL(pageUrl); } catch { return undefined; }
    return adapters.find((adapter) => adapter.pageMatches.some((pattern) => {
      if (!pattern.endsWith('/*')) return false;
      const base = new URL(pattern.slice(0, -1));
      return base.origin === url.origin && url.pathname.startsWith(base.pathname);
    }));
  },
};
