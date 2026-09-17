export function normalizeText(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/gu, ' ');
}

export function folded(value: unknown): string {
  return normalizeText(value).toLocaleLowerCase('zh-CN');
}

