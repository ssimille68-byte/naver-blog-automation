# 작업 지침

네이버 블로그 자동화 도구. Node.js ESM, 빌드 도구 없음.

## 핵심 원칙

- **AI 호출은 반드시 `server/ai/claude-cli.js` 의 `ask()` / `askJson()` 를 거친다.**
  Anthropic SDK 나 API 키를 직접 쓰지 말 것 — 이 프로젝트는 `claude -p` 로 구독 요금제를 쓰는 것이 전제다.
- **사용자에게 보이는 문자열(로그·오류·UI)은 한국어로.** 코드 주석은 "왜"를 설명할 때만 쓴다.
- **네이버 DOM 선택자는 `server/naver/selectors.js` 에만 둔다.** 다른 파일에 하드코딩하지 말 것.
  선택자는 항상 후보 배열이고, `firstVisible()` / `firstPresent()` 로 조회한다.
- **네트워크·DOM 실패는 파이프라인을 멈추지 않는다.** 수집 실패는 로그를 남기고 건너뛴다.
  발행처럼 되돌릴 수 없는 동작만 예외를 던진다.

## 검증

```bash
npm test        # 모의 스마트에디터 기반 통합 테스트
npm run doctor  # 환경 점검
```

발행 로직을 고쳤다면 `npm test` 를 반드시 돌린다. 모의 에디터(`test/fixtures/editor.html`)는
실제 SE ONE 의 거동(iframe, 복구 팝업, paste→HTML 변환, 파일 업로드, 발행 레이어)을 흉내 내므로
네이버에 접속하지 않고도 회귀를 잡을 수 있다.

## 주의

- `data/` 에는 로그인 세션이 들어 있다. 커밋하지 말 것 (`.gitignore` 에 있음).
- 사용자 입력이 경로에 들어가면 `safeJoin()` 을 쓴다.
- 발행은 되돌릴 수 없다. 새 기능은 `dryRun` 경로를 함께 지원할 것.
