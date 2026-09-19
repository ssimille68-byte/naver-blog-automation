import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { LOG_DIR, ensureDirs } from './paths.js';

ensureDirs();

export const bus = new EventEmitter();
bus.setMaxListeners(0);

const RING_MAX = 500;
const ring = [];

const LEVEL_COLOR = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  ok: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

function logFilePath() {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `${day}.log`);
}

/**
 * Emit a structured log line. Every line is mirrored to stdout, an append-only
 * daily file, and the SSE bus so the dashboard console stays live.
 */
export function log(level, scope, message, extra = {}) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...extra,
  };

  ring.push(entry);
  if (ring.length > RING_MAX) ring.shift();

  const color = LEVEL_COLOR[level] || '';
  const stamp = entry.ts.slice(11, 19);
  console.log(`${color}[${stamp}] [${scope}] ${message}\x1b[0m`);

  try {
    fs.appendFileSync(logFilePath(), JSON.stringify(entry) + '\n');
  } catch {
    // 로그 파일 기록 실패가 파이프라인을 멈추게 해서는 안 된다.
  }

  bus.emit('log', entry);
  return entry;
}

export const logger = {
  debug: (scope, msg, extra) => log('debug', scope, msg, extra),
  info: (scope, msg, extra) => log('info', scope, msg, extra),
  ok: (scope, msg, extra) => log('ok', scope, msg, extra),
  warn: (scope, msg, extra) => log('warn', scope, msg, extra),
  error: (scope, msg, extra) => log('error', scope, msg, extra),
};

export function recentLogs(limit = 200) {
  return ring.slice(-limit);
}

/** Broadcast a non-log event (job progress, state change) to the dashboard. */
export function emitEvent(type, payload) {
  bus.emit('event', { type, ts: new Date().toISOString(), ...payload });
}
