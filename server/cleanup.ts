import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.ts';

export function ensureTempDir(): void {
  if (!fs.existsSync(CONFIG.tempDir)) {
    fs.mkdirSync(CONFIG.tempDir, { recursive: true, mode: 0o700 });
  }
}

export function removeDirSafe(dirPath: string): void {
  try {
    const resolved = path.resolve(dirPath);
    if (!resolved.startsWith(CONFIG.tempDir)) {
      return;
    }
    if (fs.existsSync(resolved)) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  } catch {
    // Best-effort cleanup
  }
}

export function purgeExpiredDirectories(activeJobIds: Set<string>): number {
  ensureTempDir();
  const maxAgeMs = CONFIG.autoCleanupMinutes * 60 * 1000;
  const now = Date.now();
  let removed = 0;

  try {
    const entries = fs.readdirSync(CONFIG.tempDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (activeJobIds.has(entry.name)) continue;

      const fullPath = path.join(CONFIG.tempDir, entry.name);
      try {
        const stats = fs.statSync(fullPath);
        if (now - stats.mtimeMs > maxAgeMs) {
          fs.rmSync(fullPath, { recursive: true, force: true });
          removed += 1;
        }
      } catch {
        // Ignore race condition on already removed folder
      }
    }
  } catch {
    // Ignore read errors
  }

  return removed;
}
