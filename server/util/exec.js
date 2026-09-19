import fs from 'node:fs';
import path from 'node:path';

/**
 * 윈도우에서 실행 파일을 찾고 실행하는 방법은 리눅스·맥과 다르다.
 *
 * npm 으로 설치된 CLI(`npx`, `claude`)는 윈도우에서 `npx.cmd` 처럼 배치 파일로 깔린다.
 * Node 의 spawn 은 shell 없이는 `.cmd` 를 찾지도 실행하지도 못해서 ENOENT 로 죽는다.
 * 그래서 PATH 를 직접 훑어 확장자까지 찾아낸 뒤, 배치 파일이면 셸을 거쳐 실행한다.
 *
 * 순수 함수로 분리해 두었으므로 리눅스에서도 win32 동작을 그대로 시험할 수 있다.
 */

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * Locate an executable by name, the way the OS shell would.
 *
 * @returns {string|null} 절대 경로. 못 찾으면 null (그때는 OS 의 PATH 탐색에 맡긴다).
 */
export function findExecutable(name, options = {}) {
  const {
    platform = process.platform,
    pathEnv = process.env.PATH || '',
    pathExt = process.env.PATHEXT || DEFAULT_PATHEXT,
    exists = (file) => fs.existsSync(file),
  } = options;

  // 이미 경로가 박힌 이름이면 그대로 확인만 한다.
  if (name.includes('/') || name.includes('\\')) return exists(name) ? name : null;

  const isWindows = platform === 'win32';
  const separator = isWindows ? ';' : ':';
  const extensions = isWindows ? ['', ...pathExt.split(';').filter(Boolean)] : [''];
  // platform 을 인자로 받는 함수이므로 경로 결합도 그 플랫폼 규칙을 따라야 한다.
  // (host 의 path.join 을 쓰면 리눅스에서 윈도우 경로를 만들 때 구분자가 섞인다.)
  const join = isWindows ? path.win32.join : path.posix.join;

  for (const dir of pathEnv.split(separator).filter(Boolean)) {
    // 윈도우 PATH 항목은 따옴표가 붙어 있는 경우가 있다.
    const clean = dir.replace(/^"|"$/g, '');
    for (const ext of extensions) {
      const candidate = join(clean, name + ext);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/** Quote one argument for a Windows command line. */
export function quoteWindowsArg(value) {
  const text = String(value);
  if (text === '') return '""';
  if (!/[\s"^&|<>()]/.test(text)) return text;
  // 따옴표 앞의 역슬래시는 두 배로 늘려야 하고, 따옴표 자체는 \" 로 이스케이프한다.
  const escaped = text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
  return `"${escaped}"`;
}

/**
 * Decide how to spawn a command so it works on every platform.
 *
 * @returns {{file: string, args: string[], options: object, resolved: string|null}}
 */
export function buildSpawnPlan(command, args, options = {}) {
  const { platform = process.platform, find = findExecutable } = options;
  const resolved = find(command, options);

  if (platform !== 'win32') {
    return { file: resolved || command, args, options: {}, resolved };
  }

  const isBatch = /\.(cmd|bat)$/i.test(resolved || '');
  if (!isBatch && resolved) {
    // .exe 는 그냥 실행된다. 인자 인용은 Node 가 알아서 한다.
    return { file: resolved, args, options: {}, resolved };
  }

  // 배치 파일이거나 아예 못 찾은 경우 — 셸을 거친다. 인용은 우리가 직접 한다.
  // (Node 는 shell:true 일 때 인자를 인용해 주지 않는다.)
  const target = resolved || command;
  // 실행 파일 경로는 공백이 없어도 항상 감싼다. "C:\Program Files\..." 같은 경로가 흔하고,
  // 감싸도 cmd 동작에는 영향이 없다.
  const head = resolved ? `"${target}"` : quoteWindowsArg(target);
  const line = [head, ...args.map(quoteWindowsArg)].join(' ');
  return { file: line, args: [], options: { shell: true, windowsHide: true }, resolved };
}
