import { describe, expect, it } from 'vitest';
import manifest from '../../public/manifest.json';
import { sourceRegistry } from './source-registry';
import type { SearchSourceAdapter } from './types';

type SourcePermissions = Pick<SearchSourceAdapter, 'pageMatches' | 'apiHosts'>;
type ManifestPermissions = Pick<typeof manifest, 'content_scripts' | 'host_permissions'>;

function expectManifestCoverage(adapters: readonly SourcePermissions[], permissions: ManifestPermissions) {
  const pageMatches = new Set(permissions.content_scripts.flatMap((script) => script.matches));
  const apiHosts = new Set(permissions.host_permissions);
  const requiredPages = new Set(adapters.flatMap((adapter) => adapter.pageMatches));
  const requiredHosts = new Set(adapters.flatMap((adapter) => adapter.apiHosts));

  expect([...requiredPages].filter((pattern) => !pageMatches.has(pattern)), 'Missing content_scripts.matches').toEqual([]);
  expect([...requiredHosts].filter((pattern) => !apiHosts.has(pattern)), 'Missing host_permissions').toEqual([]);
}

const additionalSource: SourcePermissions = {
  pageMatches: ['https://campus.example.test/*'],
  apiHosts: ['https://api.campus.example.test/*'],
};

function manifestWithAdditionalSource(): ManifestPermissions {
  return {
    content_scripts: [...manifest.content_scripts, {
      ...manifest.content_scripts[0], matches: additionalSource.pageMatches,
    }],
    host_permissions: [...manifest.host_permissions, ...additionalSource.apiHosts],
  };
}

describe('source registry / manifest contract', () => {
  it('covers the page and API patterns of every registered adapter', () => {
    expect(sourceRegistry.adapters.length).toBeGreaterThan(0);
    expectManifestCoverage(sourceRegistry.adapters, manifest);
  });

  it('limits the WebVPN page bridge to the CC98 mapping', () => {
    const bridge = manifest.content_scripts.find((script) => script.js.includes('cc98-webvpn-bridge.js'));
    expect(bridge).toMatchObject({ run_at: 'document_start', world: 'MAIN' });
    expect(bridge?.matches).toEqual([
      'https://webvpn.zju.edu.cn/https/77726476706e69737468656265737421e7e056d22433310830079bab/*',
    ]);
  });

  it('rejects a new adapter whose page matches are missing', () => {
    const permissions = manifestWithAdditionalSource();
    permissions.content_scripts = manifest.content_scripts;
    expect(() => expectManifestCoverage([...sourceRegistry.adapters, additionalSource], permissions))
      .toThrow('Missing content_scripts.matches');
  });

  it('rejects a new adapter whose API hosts are missing', () => {
    const permissions = manifestWithAdditionalSource();
    permissions.host_permissions = manifest.host_permissions;
    expect(() => expectManifestCoverage([...sourceRegistry.adapters, additionalSource], permissions))
      .toThrow('Missing host_permissions');
  });

  it('accepts the adapter union across script entries and additional model host permissions', () => {
    const permissions = manifestWithAdditionalSource();
    permissions.host_permissions.push('https://models.example.test/*');
    expectManifestCoverage([...sourceRegistry.adapters, additionalSource], permissions);
  });
});
