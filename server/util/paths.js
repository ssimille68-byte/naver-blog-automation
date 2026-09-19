import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..', '..');
export const DATA_DIR = process.env.NBA_DATA_DIR
  ? path.resolve(process.env.NBA_DATA_DIR)
  : path.join(ROOT, 'data');

export const PROFILE_DIR = path.join(DATA_DIR, 'browser-profile');
export const IMAGE_DIR = path.join(DATA_DIR, 'images');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
export const PUBLIC_DIR = path.join(ROOT, 'public');

export function ensureDirs() {
  for (const dir of [DATA_DIR, PROFILE_DIR, IMAGE_DIR, LOG_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Guard against path traversal when a path segment comes from the client. */
export function safeJoin(base, ...segments) {
  const target = path.resolve(base, ...segments);
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`허용되지 않은 경로입니다: ${segments.join('/')}`);
  }
  return target;
}
