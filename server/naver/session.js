import fs from 'node:fs';
import path from 'node:path';
import { logger, emitEvent } from '../util/logger.js';
import { DATA_DIR, PROFILE_DIR, ensureDirs } from '../util/paths.js';
import { ensureBrowserInstalled, hasDisplay, withProfile } from '../browser.js';
import { settings } from '../store.js';

ensureDirs();

const SESSION_FILE = path.join(DATA_DIR, 'naver-session.json');
const LOGIN_URL = 'https://nid.naver.com/nidlogin.login?mode=form&url=https%3A%2F%2Fwww.naver.com';

/** Naver keeps the signed-in state in these two cookies. */
const AUTH_COOKIES = ['NID_AUT', 'NID_SES'];

let loginInFlight = null;

export function readSavedSession() {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeSavedSession(value) {
  fs.writeFileSync(SESSION_FILE, JSON.stringify(value, null, 2));
}

function cookiesLookAuthenticated(cookies) {
  const names = new Set(cookies.filter((c) => c.domain.includes('naver.com')).map((c) => c.name));
  return AUTH_COOKIES.every((name) => names.has(name));
}

/**
 * Report whether we are logged in. `deep: true` actually opens a browser and
 * asks Naver; the cheap path only looks at the cookies we stored.
 */
export async function getLoginStatus({ deep = false } = {}) {
  const saved = readSavedSession();
  const base = {
    loggedIn: Boolean(saved?.loggedIn),
    naverId: saved?.naverId || null,
    blogId: saved?.blogId || settings.get().blogId || null,
    checkedAt: saved?.checkedAt || null,
    profileExists: fs.existsSync(path.join(PROFILE_DIR, 'Default')),
  };
  if (!deep) return base;

  try {
    const probe = await withProfile(async (context) => verifyLogin(context), { headless: true });
    const merged = { ...base, ...probe, checkedAt: new Date().toISOString() };
    writeSavedSession({ ...readSavedSession(), ...merged });
    return merged;
  } catch (err) {
    logger.warn('naver', `로그인 상태 확인 실패: ${err.message}`);
    return { ...base, error: err.message };
  }
}

/** Visit Naver with the stored profile and read back who we are. */
async function verifyLogin(context) {
  const page = await context.newPage();
  try {
    await page.goto('https://www.naver.com', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);

    const cookies = await context.cookies();
    const loggedIn = cookiesLookAuthenticated(cookies);
    if (!loggedIn) return { loggedIn: false, naverId: null, blogId: null };

    const naverId = await readNaverId(page);
    const blogId = naverId || settings.get().blogId || null;
    return { loggedIn: true, naverId, blogId };
  } finally {
    await page.close().catch(() => {});
  }
}

/** The logged-in id is exposed on the Naver home "my area" widget. */
async function readNaverId(page) {
  const fromHome = await page
    .evaluate(() => {
      const el = document.querySelector('.MyView-module__name_text___yZKXB, .link_login, .MyView-module__link_login___HpHMW');
      const text = el?.textContent?.trim();
      return text && !text.includes('로그인') ? text : null;
    })
    .catch(() => null);
  if (fromHome) return fromHome;

  // 블로그 홈으로 이동하면 URL 에 내 블로그 아이디가 그대로 담긴다.
  try {
    await page.goto('https://blog.naver.com', { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.waitForTimeout(800);
    const match = page.url().match(/blog\.naver\.com\/([A-Za-z0-9_-]+)/);
    if (match && !['PostList', 'MyBlog'].includes(match[1])) return match[1];
  } catch {
    // 조회 실패는 치명적이지 않다 — 아이디는 설정에서 직접 넣을 수 있다.
  }
  return null;
}

/**
 * Open a real browser window on the user's machine so they can sign in by hand
 * (ID/PW, 2FA, captcha — whatever Naver asks), then persist the session.
 *
 * Resolves once the auth cookies appear, the window is closed, or we time out.
 */
export async function startInteractiveLogin({ timeoutMs = 5 * 60_000 } = {}) {
  if (loginInFlight) {
    return { alreadyRunning: true, ...(await loginInFlight) };
  }
  loginInFlight = runInteractiveLogin({ timeoutMs }).finally(() => {
    loginInFlight = null;
  });
  return loginInFlight;
}

export function isLoginInFlight() {
  return Boolean(loginInFlight);
}

async function runInteractiveLogin({ timeoutMs }) {
  await ensureBrowserInstalled();

  if (!hasDisplay()) {
    throw new Error(
      '화면(디스플레이)이 없는 환경이라 로그인 창을 띄울 수 없습니다. ' +
        '데스크톱에서 실행하거나, 리눅스 서버라면 `xvfb-run -a npm start` 처럼 가상 디스플레이를 붙여 주세요.',
    );
  }

  logger.info('naver', '네이버 로그인 창을 엽니다. 브라우저에서 직접 로그인해 주세요.');
  emitEvent('login:opened', {});

  return withProfile(
    async (context) => {
      const page = context.pages()[0] || (await context.newPage());
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

      const deadline = Date.now() + timeoutMs;
      let windowClosed = false;
      page.on('close', () => {
        windowClosed = true;
      });

      while (Date.now() < deadline) {
        if (windowClosed && context.pages().length === 0) {
          throw new Error('로그인 창이 닫혔습니다. 로그인을 완료하지 못했습니다.');
        }
        const cookies = await context.cookies().catch(() => []);
        if (cookiesLookAuthenticated(cookies)) {
          logger.ok('naver', '로그인 쿠키를 확인했습니다. 세션을 저장합니다.');
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }

      const cookies = await context.cookies().catch(() => []);
      if (!cookiesLookAuthenticated(cookies)) {
        throw new Error('제한 시간 안에 로그인이 확인되지 않았습니다. 다시 시도해 주세요.');
      }

      const active = context.pages().find((p) => !p.isClosed());
      const naverId = active ? await readNaverId(active).catch(() => null) : null;

      // 프로필 디렉터리가 진짜 저장소지만, 사람이 눈으로 확인할 수 있게 쿠키도 남긴다.
      const record = {
        loggedIn: true,
        naverId,
        blogId: naverId || settings.get().blogId || null,
        savedAt: new Date().toISOString(),
        checkedAt: new Date().toISOString(),
        cookies: cookies.filter((c) => c.domain.includes('naver.com')),
        profileDir: PROFILE_DIR,
      };
      writeSavedSession(record);
      if (naverId && !settings.get().blogId) settings.update({ blogId: naverId });

      logger.ok('naver', `로그인 완료${naverId ? ` (${naverId})` : ''}. 세션을 로컬에 저장했습니다.`);
      emitEvent('login:success', { naverId, blogId: record.blogId });
      return { loggedIn: true, naverId, blogId: record.blogId };
    },
    { headless: false, slowMo: 0 },
  );
}

/** Forget the stored session: cookies file + the whole browser profile. */
export async function logout() {
  fs.rmSync(SESSION_FILE, { force: true });
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  logger.info('naver', '저장된 네이버 세션을 삭제했습니다.');
  emitEvent('login:cleared', {});
  return { loggedIn: false };
}
