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
      // Registered patterns currently cover every path of one exact HTTPS host.
      const origin = pattern.endsWith('/*') ? pattern.slice(0, -2) : null;
      return origin === url.origin;
    }));
  },
};
