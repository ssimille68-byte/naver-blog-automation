/**
 * 윈도우 실행 경로 처리 테스트.
 *
 * 실제 윈도우가 없어도 검증할 수 있도록 platform·PATH·파일 존재 여부를 주입한다.
 * 이 로직이 깨지면 윈도우에서 `npx`/`claude` 를 찾지 못해 ENOENT 로 죽는다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSpawnPlan, findExecutable, quoteWindowsArg } from '../server/util/exec.js';

const WIN_PATH = 'C:\\Windows\\system32;C:\\Users\\black\\AppData\\Roaming\\npm';

/**
 * 윈도우 파일시스템은 대소문자를 구분하지 않는다. PATHEXT 는 대문자(.CMD)인데
 * 실제 파일은 소문자(npx.cmd)이므로, 그 동작을 그대로 흉내 내야 한다.
 */
const fakeFs = (paths) => {
  const lower = new Set([...paths].map((file) => file.toLowerCase()));
  return (file) => lower.has(file.toLowerCase());
};

const winFiles = [
  'C:\\Windows\\system32\\cmd.exe',
  'C:\\Users\\black\\AppData\\Roaming\\npm\\npx.cmd',
  'C:\\Users\\black\\AppData\\Roaming\\npm\\claude.cmd',
];
const win = (overrides = {}) => ({
  platform: 'win32',
  pathEnv: WIN_PATH,
  pathExt: '.COM;.EXE;.BAT;.CMD',
  exists: fakeFs(winFiles),
  ...overrides,
});

/** 대소문자만 다른 경로는 같은 것으로 본다 (윈도우 기준). */
const samePath = (actual, expected, message) =>
  assert.equal(String(actual).toLowerCase(), expected.toLowerCase(), message);

test('findExecutable: 윈도우에서 확장자 없는 이름으로 .cmd 를 찾아낸다', () => {
  samePath(findExecutable('npx', win()), 'C:\\Users\\black\\AppData\\Roaming\\npm\\npx.cmd');
  samePath(findExecutable('claude', win()), 'C:\\Users\\black\\AppData\\Roaming\\npm\\claude.cmd');
});

test('findExecutable: PATHEXT 순서를 지킨다 (.exe 가 .cmd 보다 먼저)', () => {
  const found = findExecutable('tool', win({
    pathEnv: 'C:\\bin',
    exists: fakeFs(['C:\\bin\\tool.cmd', 'C:\\bin\\tool.exe']),
  }));
  samePath(found, 'C:\\bin\\tool.exe');
});

test('findExecutable: 따옴표가 붙은 PATH 항목도 처리한다', () => {
  const found = findExecutable('tool', win({
    pathEnv: '"C:\\Program Files\\x"',
    exists: fakeFs(['C:\\Program Files\\x\\tool.exe']),
  }));
  samePath(found, 'C:\\Program Files\\x\\tool.exe');
});

test('findExecutable: 못 찾으면 null 을 돌려준다 (OS 탐색에 맡긴다)', () => {
  assert.equal(findExecutable('nope', win()), null);
});

test('findExecutable: 리눅스에서는 확장자를 붙이지 않는다', () => {
  assert.equal(
    findExecutable('claude', { platform: 'linux', pathEnv: '/usr/bin:/bin', exists: fakeFs(['/usr/bin/claude']) }),
    '/usr/bin/claude',
  );
});

test('quoteWindowsArg: 공백·따옴표·빈 문자열을 안전하게 감싼다', () => {
  assert.equal(quoteWindowsArg('sonnet'), 'sonnet', '단순한 값은 그대로 둔다');
  assert.equal(quoteWindowsArg('C:\\Users\\black\\OneDrive\\Desktop\\a b'), '"C:\\Users\\black\\OneDrive\\Desktop\\a b"');
  assert.equal(quoteWindowsArg(''), '""');
  assert.equal(quoteWindowsArg('say "hi"'), '"say \\"hi\\""');
  assert.equal(quoteWindowsArg('a&b'), '"a&b"', 'cmd 메타문자는 따옴표로 막는다');
});

test('buildSpawnPlan: 윈도우의 .cmd 는 셸을 거치고 인자를 직접 인용한다', () => {
  const plan = buildSpawnPlan('claude', ['-p', '--model', 'sonnet', '--add-dir', 'C:\\a b\\c'], win());

  assert.equal(plan.options.shell, true);
  assert.deepEqual(plan.args, [], '셸 모드에서는 인자를 명령줄에 합쳐 넣는다');
  assert.match(plan.file.toLowerCase(), /^"c:\\users\\black\\appdata\\roaming\\npm\\claude\.cmd"/,
    '실행 파일 경로는 항상 따옴표로 감싼다 (Program Files 같은 공백 경로 대비)');
  assert.ok(plan.file.includes('"C:\\a b\\c"'), '공백이 든 경로가 인용되어야 한다');
  assert.ok(plan.file.includes(' -p '), '단순 인자는 그대로 이어 붙인다');
});

test('buildSpawnPlan: 윈도우의 .exe(네이티브 설치본)는 셸 없이 그대로 실행한다', () => {
  const plan = buildSpawnPlan('claude', ['-p'], win({
    pathEnv: 'C:\\Users\\black\\.local\\bin',
    exists: fakeFs(['C:\\Users\\black\\.local\\bin\\claude.exe']),
  }));

  samePath(plan.file, 'C:\\Users\\black\\.local\\bin\\claude.exe');
  assert.deepEqual(plan.args, ['-p']);
  assert.equal(plan.options.shell, undefined, '.exe 는 셸이 필요 없다');
});

test('buildSpawnPlan: 공백이 든 설치 경로도 깨지지 않는다', () => {
  const plan = buildSpawnPlan('claude', ['-p'], win({
    pathEnv: 'C:\\Program Files\\nodejs',
    exists: fakeFs(['C:\\Program Files\\nodejs\\claude.cmd']),
  }));
  assert.match(plan.file, /^"C:\\Program Files\\nodejs\\claude\.(cmd|CMD)" -p$/);
});

test('buildSpawnPlan: 윈도우에서 못 찾으면 셸에 맡긴다', () => {
  const plan = buildSpawnPlan('claude', ['-p'], win({ exists: () => false }));
  assert.equal(plan.options.shell, true);
  assert.equal(plan.resolved, null);
  assert.match(plan.file, /^claude -p$/);
});

test('buildSpawnPlan: 리눅스·맥은 인자를 그대로 넘긴다', () => {
  const plan = buildSpawnPlan('claude', ['-p', '--model', 'sonnet'], {
    platform: 'darwin',
    pathEnv: '/usr/bin',
    exists: fakeFs(['/usr/bin/claude']),
  });

  assert.equal(plan.file, '/usr/bin/claude');
  assert.deepEqual(plan.args, ['-p', '--model', 'sonnet']);
  assert.deepEqual(plan.options, {}, '셸을 거치지 않아야 한다');
});
