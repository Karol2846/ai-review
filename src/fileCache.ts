import { readFileSync } from "node:fs";

interface CacheEntry {
  content: string;
  cachedAt: number;
}

const cache: Record<string, CacheEntry> = {};
let hitCount = 0;
let missCount = 0;

export function getCachedFile(filePath: string, ttlMs: number = 60_000): string {
  const entry = cache[filePath];
  if (entry && Date.now() - entry.cachedAt < ttlMs) {
    hitCount++;
    return entry.content;
  }
  missCount++;
  const content = readFileSync(filePath, "utf8");
  cache[filePath] = { content, cachedAt: Date.now() };
  return content;
}

export function invalidate(filePath: string): void {
  delete cache[filePath];
}

export function getHitRate(): number {
  const total = hitCount + missCount;
  return total === 0 ? 0 : hitCount / total;
}

export function clearAll(): void {
  for (const key of Object.keys(cache)) {
    delete cache[key];
  }
  hitCount = 0;
  missCount = 0;
}
