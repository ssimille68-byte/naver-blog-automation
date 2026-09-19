import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * 네이버 블로그 글쓰기 화면을 흉내 내는 로컬 서버.
 * 실제 네이버에 접속하지 않고 발행 자동화 로직을 검증하기 위한 것이다.
 */
export function startMockNaver(port = 4399) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let file = 'shell.html';
    if (url.pathname === '/editor.html') file = 'editor.html';
    else if (url.pathname.startsWith('/blog.naver.com/')) file = 'post.html';

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(FIXTURES, file)));
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${port}/` }));
  });
}

// 윈도우 경로는 file:///C:/... 형태라 문자열을 직접 이어 붙이면 절대 일치하지 않는다.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { url } = await startMockNaver();
  console.log(`모의 네이버 에디터: ${url}`);
}
