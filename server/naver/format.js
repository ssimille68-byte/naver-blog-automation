/**
 * 초안의 블록 구조를 네이버 에디터에 넣을 형태로 바꾼다.
 *
 * 스마트에디터 ONE 은 붙여넣기(paste) 이벤트로 들어온 HTML 을 자기 컴포넌트로
 * 변환해 준다. 그래서 가독성 서식(소제목·굵기·목록·인용구)은 HTML 로 만들어
 * 한 번에 넣고, 이미지는 파일 업로드가 필요하므로 따로 처리한다.
 */

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 문단 안의 강조 표현을 살린다. AI 에게 마크다운을 쓰라고 시키지는 않지만,
 * 습관적으로 **강조** 를 넣는 경우가 있어 그대로 통과시키지 않고 태그로 바꾼다.
 */
function inline(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(?<!\w)__(.+?)__(?!\w)/g, '<b>$1</b>')
    .replace(/\n/g, '<br>');
}

const STYLE = {
  heading: 'font-size:19pt;font-weight:bold;line-height:1.6;',
  paragraph: 'font-size:12pt;line-height:1.8;',
  quote: 'font-size:12pt;line-height:1.8;',
  caption: 'font-size:10pt;color:#888888;',
};

/** Render one block group to HTML for the paste path. */
export function blockToHtml(block) {
  switch (block.type) {
    case 'heading':
      return `<h3 style="${STYLE.heading}">${inline(block.text)}</h3>`;
    case 'quote':
      return `<blockquote style="border-left:3px solid #cccccc;padding-left:12px;color:#555555;${STYLE.quote}">${inline(
        block.text,
      )}</blockquote>`;
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      const items = block.items.map((item) => `<li style="${STYLE.paragraph}">${inline(item)}</li>`).join('');
      return `<${tag}>${items}</${tag}>`;
    }
    case 'divider':
      return '<hr>';
    case 'paragraph':
    default:
      return `<p style="${STYLE.paragraph}">${inline(block.text)}</p>`;
  }
}

export function blockToPlain(block) {
  switch (block.type) {
    case 'list':
      return block.items.map((item) => `· ${item}`).join('\n');
    case 'divider':
      return '─────────────────';
    case 'quote':
      return `"${block.text}"`;
    default:
      return block.text || '';
  }
}

/**
 * 이미지 블록을 기준으로 본문을 조각낸다.
 * → [{kind:'html', html, plain}, {kind:'image', block}, ...]
 *
 * 붙여넣기는 조각 단위로 하고, 이미지는 그 사이사이에 업로드해 넣는다.
 */
export function buildSegments(blocks) {
  const segments = [];
  let buffer = [];

  const flush = () => {
    if (!buffer.length) return;
    segments.push({
      kind: 'html',
      html: buffer.map(blockToHtml).join(''),
      plain: buffer.map(blockToPlain).filter(Boolean).join('\n\n'),
      blocks: buffer,
    });
    buffer = [];
  };

  for (const block of blocks) {
    if (block.type === 'image') {
      // 준비되지 않은 이미지는 조용히 건너뛴다 (본문에 빈 자리를 남기지 않는다).
      if (block.status !== 'ready' || !block.file) continue;
      flush();
      segments.push({ kind: 'image', block });
      continue;
    }
    buffer.push(block);
  }
  flush();
  return segments;
}

/** Plain-text preview used by the dashboard and the dry-run output. */
export function renderPreviewText(blocks) {
  return blocks
    .map((block) => {
      if (block.type === 'heading') return `\n## ${block.text}\n`;
      if (block.type === 'image') {
        const state = block.status === 'ready' ? `이미지: ${block.caption || block.query}` : `이미지 없음 (${block.error || block.status})`;
        return `\n[${state}]\n`;
      }
      return blockToPlain(block);
    })
    .join('\n');
}

export function renderPreviewHtml(blocks, imageUrlFor) {
  return blocks
    .map((block) => {
      if (block.type !== 'image') return blockToHtml(block);
      if (block.status !== 'ready') {
        return `<div class="img-missing">이미지를 넣지 못했습니다 — ${escapeHtml(block.error || block.status || '')}</div>`;
      }
      const src = imageUrlFor(block);
      return `<figure><img src="${escapeHtml(src)}" alt="${escapeHtml(block.altText || block.caption || '')}" loading="lazy"><figcaption>${escapeHtml(
        block.caption || '',
      )}${block.credit ? ` <span class="credit">(${escapeHtml(block.credit)})</span>` : ''}</figcaption></figure>`;
    })
    .join('\n');
}
