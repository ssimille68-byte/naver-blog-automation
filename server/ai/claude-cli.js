import { spawn } from 'node:child_process';
import { logger } from '../util/logger.js';
import { DATA_DIR } from '../util/paths.js';

/**
 * 이 프로젝트의 모든 AI 호출은 Claude Code CLI 의 `-p`(print) 모드를 통해 나간다.
 * 그래서 별도의 API 키 없이 로그인된 구독 요금제를 그대로 사용한다.
 */
const CLI = process.env.CLAUDE_CLI_PATH || 'claude';

const MAX_CONCURRENT = Number(process.env.NBA_AI_CONCURRENCY || 2);
let active = 0;
const waiting = [];

function acquire() {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  active -= 1;
  const next = waiting.shift();
  if (next) {
    active += 1;
    next();
  }
}

export class ClaudeCliError extends Error {
  constructor(message, { stderr, code } = {}) {
    super(message);
    this.name = 'ClaudeCliError';
    this.stderr = stderr;
    this.code = code;
  }
}

/** Is the CLI present and authenticated enough to run? */
export async function checkCli() {
  try {
    const version = await execCli(['--version'], { timeout: 20_000 });
    return { available: true, version: version.trim() };
  } catch (err) {
    return { available: false, error: err.message };
  }
}

function execCli(args, { input, timeout = 300_000, cwd = DATA_DIR } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLI, args, {
      cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new ClaudeCliError(`Claude CLI 응답이 ${Math.round(timeout / 1000)}초를 초과했습니다.`));
    }, timeout);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const hint =
        err.code === 'ENOENT'
          ? 'Claude Code CLI(`claude`)를 찾을 수 없습니다. `npm i -g @anthropic-ai/claude-code` 로 설치하고 `claude login` 을 먼저 실행하세요.'
          : err.message;
      reject(new ClaudeCliError(hint, { code: err.code }));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) return resolve(stdout);
      reject(
        new ClaudeCliError(
          `Claude CLI 가 코드 ${code} 로 종료되었습니다: ${stderr.trim().slice(0, 500) || '(stderr 없음)'}`,
          { stderr, code },
        ),
      );
    });

    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

/**
 * Run one prompt through `claude -p`. Returns the assistant's text result.
 *
 * @param {string} prompt          사용자 프롬프트 (stdin 으로 전달, 길이 제한 없음)
 * @param {object} opts
 * @param {string} [opts.system]   시스템 프롬프트에 덧붙일 지시문
 * @param {string} [opts.model]    'sonnet' | 'opus' | 'haiku' | 전체 모델명
 * @param {string[]} [opts.allowedTools] 허용할 도구 (이미지 판독 시 ['Read'])
 * @param {string[]} [opts.addDirs]      도구가 접근할 수 있는 추가 디렉터리
 * @param {number} [opts.timeout]
 * @param {string} [opts.label]    로그에 남길 작업 이름
 */
export async function ask(prompt, opts = {}) {
  const {
    system,
    model = 'sonnet',
    allowedTools = [],
    addDirs = [],
    timeout = 300_000,
    label = 'ask',
  } = opts;

  const args = ['-p', '--output-format', 'json', '--model', model];

  if (system) args.push('--append-system-prompt', system);

  if (allowedTools.length) {
    args.push('--allowedTools', allowedTools.join(','));
  } else {
    // 도구가 필요 없는 순수 생성 작업은 도구 자체를 막아 두는 편이 빠르고 안전하다.
    args.push('--disallowedTools', 'Bash,Write,Edit,WebFetch,WebSearch,Task');
  }
  // print 모드에서 권한 프롬프트가 뜨면 응답이 없으므로, 미허용 도구는 자동 거부시킨다.
  args.push('--permission-mode', 'dontAsk');

  for (const dir of addDirs) args.push('--add-dir', dir);

  await acquire();
  const started = Date.now();
  try {
    logger.debug('ai', `Claude CLI 호출: ${label} (model=${model})`);
    const raw = await execCli(args, { input: prompt, timeout });

    let text;
    let meta = {};
    try {
      const parsed = JSON.parse(raw);
      text = typeof parsed.result === 'string' ? parsed.result : raw;
      meta = {
        durationMs: parsed.duration_ms,
        turns: parsed.num_turns,
        isError: parsed.is_error,
      };
      if (parsed.is_error) {
        throw new ClaudeCliError(`Claude 가 오류를 반환했습니다: ${String(text).slice(0, 300)}`);
      }
    } catch (err) {
      if (err instanceof ClaudeCliError) throw err;
      // --output-format json 이 아닌 평문이 올라온 경우 그대로 사용한다.
      text = raw;
    }

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    logger.debug('ai', `Claude CLI 완료: ${label} (${seconds}s, ${String(text).length}자)`, meta);
    return String(text).trim();
  } finally {
    release();
  }
}

/** Pull the first JSON object/array out of a model response. */
export function extractJson(text) {
  const trimmed = String(text).trim();

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fenced) candidates.push(fenced[1].trim());
  candidates.push(trimmed);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // 앞뒤에 설명 문장이 붙은 경우 가장 바깥 괄호 쌍만 잘라낸다.
      const start = candidate.search(/[[{]/);
      if (start === -1) continue;
      const opener = candidate[start];
      const closer = opener === '{' ? '}' : ']';
      const end = candidate.lastIndexOf(closer);
      if (end <= start) continue;
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        continue;
      }
    }
  }
  throw new Error('응답에서 JSON 을 찾지 못했습니다.');
}

/**
 * Ask for JSON and parse it, retrying once with the parse error fed back in.
 */
export async function askJson(prompt, opts = {}) {
  const jsonRule =
    '\n\n출력 규칙: 설명이나 인사말 없이, 요청된 스키마를 정확히 따르는 JSON 하나만 출력하세요. 코드펜스도 붙이지 마세요.';

  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const body =
      attempt === 1
        ? prompt + jsonRule
        : `${prompt}${jsonRule}\n\n이전 시도는 다음 이유로 파싱에 실패했습니다: ${lastError}\n반드시 유효한 JSON 만 출력하세요.`;
    const text = await ask(body, { ...opts, label: `${opts.label || 'ask'}#${attempt}` });
    try {
      return extractJson(text);
    } catch (err) {
      lastError = err.message;
      logger.warn('ai', `JSON 파싱 실패 (시도 ${attempt}/2): ${err.message}`);
    }
  }
  throw new Error(`Claude 응답을 JSON 으로 파싱하지 못했습니다: ${lastError}`);
}
