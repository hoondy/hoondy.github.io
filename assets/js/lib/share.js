// Share bar: native share sheet when the device has one, copy link, optional image download,
// and plain intent links for the big networks. Buttons are styled as route bullets in main.css
// (.sharebar, .sharebar__btn, .sharebar__bullet).

const enc = encodeURIComponent;

export const TARGETS = {
  x: { label: 'X', glyph: 'X', color: '#000000', href: ({ url, text }) => `https://x.com/intent/post?text=${enc(text)}&url=${enc(url)}` },
  facebook: { label: 'Facebook', glyph: 'f', color: '#1877F2', href: ({ url }) => `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}` },
  linkedin: { label: 'LinkedIn', glyph: 'in', color: '#0A66C2', href: ({ url }) => `https://www.linkedin.com/sharing/share-offsite/?url=${enc(url)}` },
  reddit: { label: 'Reddit', glyph: 'r', color: '#FF4500', href: ({ url, title }) => `https://www.reddit.com/submit?url=${enc(url)}&title=${enc(title)}` },
  threads: { label: 'Threads', glyph: '@', color: '#000000', href: ({ url, text }) => `https://www.threads.net/intent/post?text=${enc(`${text} ${url}`)}` },
  bluesky: { label: 'Bluesky', glyph: 'b', color: '#1185FE', href: ({ url, text }) => `https://bsky.app/intent/compose?text=${enc(`${text} ${url}`)}` },
  whatsapp: { label: 'WhatsApp', glyph: 'W', color: '#25D366', href: ({ url, text }) => `https://wa.me/?text=${enc(`${text} ${url}`)}` },
  telegram: { label: 'Telegram', glyph: 'T', color: '#26A5E4', href: ({ url, text }) => `https://t.me/share/url?url=${enc(url)}&text=${enc(text)}` },
  line: { label: 'LINE', glyph: 'L', color: '#06C755', href: ({ url, text }) => `https://line.me/R/share?text=${enc(`${text}\n${url}`)}` },
  naver: { label: 'NAVER', glyph: 'N', color: '#03C75A', href: ({ url, title }) => `https://share.naver.com/web/shareView?url=${enc(url)}&title=${enc(title)}` },
  band: { label: 'BAND', glyph: 'b', color: '#00C73C', href: ({ url, text }) => `https://band.us/plugin/share?body=${enc(`${text}\n${url}`)}&route=${enc(url)}` },
  weibo: { label: 'Weibo', glyph: '微', color: '#E6162D', href: ({ url, text }) => `https://service.weibo.com/share/share.php?url=${enc(url)}&title=${enc(text)}` },
  qzone: { label: 'Qzone', glyph: 'Q', color: '#FECE00', ink: '#111111', href: ({ url, title, text }) => `https://sns.qzone.qq.com/cgi-bin/qzshare/cgi_qzshare_onekey?url=${enc(url)}&title=${enc(title)}&summary=${enc(text)}` },
  douban: { label: 'Douban', glyph: '豆', color: '#2D963D', href: ({ url, title, text }) => `https://www.douban.com/share/service?href=${enc(url)}&name=${enc(title)}&text=${enc(text)}` },
  email: { label: 'Email', glyph: '✉', color: '#4D4D4F', href: ({ url, text, title }) => `mailto:?subject=${enc(title)}&body=${enc(`${text}\n\n${url}`)}` },
};

// Sensible defaults per language; apps can pass their own list.
export const TARGETS_BY_LANG = {
  en: ['x', 'facebook', 'linkedin', 'reddit', 'threads', 'bluesky', 'whatsapp', 'email'],
  ko: ['x', 'facebook', 'threads', 'naver', 'band', 'email'],
  es: ['whatsapp', 'x', 'facebook', 'telegram', 'linkedin', 'reddit', 'email'],
  ja: ['x', 'line', 'facebook', 'threads', 'email'],
  zh: ['weibo', 'qzone', 'douban', 'x', 'email'],
};

// `more` may contain {label} for languages where the network name doesn't go last ("{label}에 공유").
// `targets` overrides a network's display name ({ email: 'Correo' }).
const DEFAULT_LABELS = { title: 'Share', share: 'Share', copy: 'Copy link', copied: 'Link copied', download: 'Save image', more: 'Share on' };

function shareOn(more, label) {
  return more.includes('{label}') ? more.replace('{label}', label) : `${more} ${label}`;
}

let toastTimer;
export function toast(message) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.add('toast--show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('toast--show'), 2200);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

export const canNativeShare = () => typeof navigator !== 'undefined' && typeof navigator.share === 'function';

export async function nativeShare({ url, text, title, file }) {
  if (!canNativeShare()) return false;
  const data = { title, text, url };
  if (file && navigator.canShare?.({ files: [file] })) data.files = [file];
  try {
    await navigator.share(data);
    return true;
  } catch (err) {
    return err?.name === 'AbortError'; // user closed the sheet: not a failure
  }
}

export function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function button(cls, html, label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `sharebar__btn ${cls}`;
  b.innerHTML = html;
  b.setAttribute('aria-label', label);
  return b;
}

const ICON_SHARE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_LINK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ICON_IMAGE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v10m-4-4 4 4 4-4M5 20h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * Mount a share bar into `el`.
 * opts: { url, text, title, targets?: string[], lang?: 'en'|'ko'|'es'|'ja'|'zh',
 *         image?: () => Promise<Blob>, imageName?: string, labels?: {...} }
 * Returns { update(partialOpts) } so a result page can refresh the text/url.
 */
export function mountShareBar(el, opts) {
  let o = { ...opts };
  const L = { ...DEFAULT_LABELS, ...(o.labels || {}) };

  const render = () => {
    const url = o.url || location.href;
    const title = o.title || document.title;
    const text = o.text || title;
    const ids = (o.targets || TARGETS_BY_LANG[o.lang] || TARGETS_BY_LANG.en).filter((id) => TARGETS[id]);

    el.textContent = '';
    el.classList.add('sharebar');

    const actions = document.createElement('div');
    actions.className = 'sharebar__actions';

    if (canNativeShare()) {
      const b = button('sharebar__btn--native', `${ICON_SHARE}<span>${L.share}</span>`, L.share);
      b.addEventListener('click', async () => {
        let file;
        if (o.image) {
          try {
            const blob = await o.image();
            file = new File([blob], o.imageName || 'hoondy.png', { type: blob.type || 'image/png' });
          } catch {
            file = undefined;
          }
        }
        await nativeShare({ url, text, title, file });
      });
      actions.append(b);
    }

    const copy = button('sharebar__btn--copy', `${ICON_LINK}<span>${L.copy}</span>`, L.copy);
    copy.addEventListener('click', async () => {
      if (await copyText(url)) toast(L.copied);
    });
    actions.append(copy);

    if (o.image) {
      const dl = button('sharebar__btn--download', `${ICON_IMAGE}<span>${L.download}</span>`, L.download);
      dl.addEventListener('click', async () => {
        try {
          downloadBlob(await o.image(), o.imageName || 'hoondy.png');
        } catch {
          /* nothing to save */
        }
      });
      actions.append(dl);
    }

    const nets = document.createElement('div');
    nets.className = 'sharebar__targets';
    nets.setAttribute('aria-label', L.title);
    for (const id of ids) {
      const t = TARGETS[id];
      const label = L.targets?.[id] || t.label;
      const a = document.createElement('a');
      a.className = `sharebar__target sharebar__target--${id}`;
      a.href = t.href({ url, text, title });
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = shareOn(L.more, label);
      a.setAttribute('aria-label', a.title);
      const bullet = document.createElement('span');
      bullet.className = 'sharebar__bullet';
      bullet.setAttribute('aria-hidden', 'true');
      bullet.style.setProperty('--bullet', t.color);
      if (t.ink) bullet.style.color = t.ink;
      bullet.textContent = t.glyph;
      const name = document.createElement('span');
      name.className = 'sharebar__label';
      name.textContent = label;
      a.append(bullet, name);
      nets.append(a);
    }

    el.append(actions, nets);
  };

  render();
  return {
    update(next) {
      o = { ...o, ...next };
      Object.assign(L, next.labels || {});
      render();
    },
  };
}
