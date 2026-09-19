import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { logger } from './util/logger.js';
import { PROFILE_DIR, ensureDirs } from './util/paths.js';

ensureDirs();

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const CONTEXT_DEFAULTS = {
  userAgent: UA,
  locale: 'ko-KR',
  timezoneId: 'Asia/Seoul',
  viewport: { width: 1440, height: 960 },
  deviceScaleFactor: 1,
};

let installPromise = null;

/** Make sure a Chromium build exists, downloading it once if it does not. */
export async function ensureBrowserInstalled() {
  try {
    const exe = chromium.executablePath();
    if (exe && fs.existsSync(exe)) return { installed: true, path: exe };
  } catch {
    // executablePath() 는 브라우저가 없으면 예외를 던진다 — 아래에서 설치한다.
  }

  if (!installPromise) {
    installPromise = runInstall().finally(() => {
      installPromise = null;
    });
  }
  return installPromise;
}

function runInstall() {
  return new Promise((resolve, reject) => {
    logger.info('browser', 'Chromium 이 없어 Playwright 브라우저를 설치합니다. 몇 분 걸릴 수 있습니다…');
    const args = ['playwright', 'install', '--with-deps', 'chromium'];
    const child = spawn('npx', args, { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });

    let tail = '';
    const capture = (chunk) => {
      tail = (tail + chunk).slice(-4000);
      const line = String(chunk).trim().split('\n').pop();
      if (line) logger.debug('browser', line);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    child.on('error', (err) => reject(new Error(`Playwright 설치 실행 실패: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) {
        logger.ok('browser', 'Chromium 설치 완료');
        return resolve({ installed: true, justInstalled: true });
      }
      // --with-deps 는 root 권한이 없으면 실패한다. 브라우저만 다시 시도한다.
      logger.warn('browser', 'OS 의존성 설치에 실패해 브라우저만 다시 설치합니다.');
      const retry = spawn('npx', ['playwright', 'install', 'chromium'], { stdio: 'inherit' });
      retry.on('close', (retryCode) => {
        if (retryCode === 0) return resolve({ installed: true, justInstalled: true });
        reject(new Error(`Playwright Chromium 설치 실패 (code ${retryCode}).\n${tail.slice(-800)}`));
      });
      retry.on('error', (err) => reject(new Error(`Playwright 설치 실행 실패: ${err.message}`)));
    });
  });
}

/**
 * 로그인 세션(쿠키·로컬스토리지)이 담기는 영속 프로필.
 *
 * 네이버 로그인 창과 발행 작업이 같은 프로필을 공유해야 하므로, 동시에 두 개가
 * 열리지 않도록 잠금을 걸고 순차적으로 실행한다.
 */
let profileContext = null;
let profileChain = Promise.resolve();

export function withProfile(fn, { headless = true, slowMo = 0 } = {}) {
  const run = async () => {
    await ensureBrowserInstalled();
    const context = await openProfile({ headless, slowMo });
    try {
      return await fn(context);
    } finally {
      await closeProfile();
    }
  };
  // 이전 작업이 끝난 뒤에 실행되도록 직렬화한다.
  profileChain = profileChain.then(run, run);
  return profileChain;
}

async function openProfile({ headless, slowMo }) {
  if (profileContext) return profileContext;
  profileContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    slowMo,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--lang=ko-KR',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    ...CONTEXT_DEFAULTS,
  });
  await hardenContext(profileContext);
  return profileContext;
}

async function closeProfile() {
  if (!profileContext) return;
  const context = profileContext;
  profileContext = null;
  try {
    await context.close();
  } catch (err) {
    logger.warn('browser', `프로필 컨텍스트 종료 중 오류: ${err.message}`);
  }
}

/** A throwaway context for scraping — never touches the logged-in profile. */
export async function withScraper(fn, { headless = true } = {}) {
  await ensureBrowserInstalled();
  const browser = await chromium.launch({
    headless,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const context = await browser.newContext(CONTEXT_DEFAULTS);
    await hardenContext(context);
    return await fn(context);
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Hide the most obvious automation fingerprints Naver checks for. */
async function hardenContext(context) {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  });
  context.setDefaultTimeout(30_000);
  context.setDefaultNavigationTimeout(60_000);
}

export function hasDisplay() {
  return process.platform !== 'linux' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}
