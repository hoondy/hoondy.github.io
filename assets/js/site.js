// Site-wide behavior for Hoondy Sq: theme, menu, clock, billboards, the arrivals
// board on the home page, comments and the share bar on posts.

import { mountShareBar } from './lib/share.js';

const root = document.documentElement;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const darkScheme = window.matchMedia('(prefers-color-scheme: dark)');

const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode: the choice just won't stick */
    }
  },
};

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/* Theme ------------------------------------------------------------------- */

function currentTheme() {
  return root.dataset.theme || (darkScheme.matches ? 'dark' : 'light');
}

function initTheme() {
  const buttons = document.querySelectorAll('[data-theme-toggle]');
  const sync = () => {
    const dark = currentTheme() === 'dark';
    buttons.forEach((b) => {
      b.setAttribute('aria-pressed', String(dark));
      b.setAttribute('aria-label', dark ? b.dataset.labelLight || 'Switch to light theme' : b.dataset.labelDark || 'Switch to dark theme');
    });
  };
  buttons.forEach((b) =>
    b.addEventListener('click', () => {
      const next = currentTheme() === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      store.set('theme', next);
      sync();
      document.dispatchEvent(new CustomEvent('themechange', { detail: { theme: next } }));
    }),
  );
  darkScheme.addEventListener('change', () => {
    sync();
    if (!root.dataset.theme) {
      document.dispatchEvent(new CustomEvent('themechange', { detail: { theme: currentTheme() } }));
    }
  });
  sync();
}

/* Mobile menu ------------------------------------------------------------- */

function initMenu() {
  const button = document.querySelector('[data-menu-toggle]');
  const menu = document.querySelector('[data-menu]');
  if (!button || !menu) return;

  const set = (open, { focus = true } = {}) => {
    button.setAttribute('aria-expanded', String(open));
    menu.hidden = !open;
    if (open && focus) menu.querySelector('a')?.focus();
  };

  button.addEventListener('click', () => set(button.getAttribute('aria-expanded') !== 'true'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) {
      set(false);
      button.focus();
    }
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !button.contains(e.target)) set(false, { focus: false });
  });
  // Tabbing past the last link would otherwise land on content hidden under the open menu.
  menu.addEventListener('focusout', (e) => {
    const to = e.relatedTarget;
    if (to && !menu.contains(to) && to !== button) set(false, { focus: false });
  });
  window.matchMedia('(min-width: 720px)').addEventListener('change', (e) => {
    if (e.matches) set(false, { focus: false });
  });
}

/* New York clock ---------------------------------------------------------- */

const nycTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });

function initClock() {
  const els = document.querySelectorAll('[data-nyc-clock]');
  if (!els.length) return;
  const update = () => {
    const t = nycTime.format(new Date());
    els.forEach((el) => {
      el.textContent = t;
    });
  };
  update();
  // line up with the top of the minute so the display flips when a real clock would
  setTimeout(() => {
    update();
    setInterval(update, 60_000);
  }, 60_050 - (Date.now() % 60_000));
}

/* Billboards -------------------------------------------------------------- */

const ROTATE_MS = 8000;

// data-state on a billboard: unset while waiting for AdSense, "ad" once it filled,
// "house" when the panel shows our own promos instead.
function setState(board, state) {
  if (board.dataset.state === state) return;
  board.dataset.state = state;
  board.dispatchEvent(new CustomEvent('billboardstate'));
}

// All promo panels on a page turn over on one clock. Each starts on a different
// promo (billboard.html staggers them), so two panels in view never show the same
// app, which independent timers would drift into. The whole clock stops while
// someone points at or tabs into a panel, for the same reason.
const rotation = { panels: [], tick: 0, timer: 0 };

function syncRotation() {
  const live = rotation.panels.filter((p) => p.live());
  const run = live.length > 0 && !live.some((p) => p.held);
  if (run && !rotation.timer) {
    rotation.timer = setInterval(() => {
      rotation.tick++;
      rotation.panels.forEach((p) => {
        if (p.live()) p.show((p.first + rotation.tick) % p.slides.length);
      });
    }, ROTATE_MS);
  } else if (!run && rotation.timer) {
    clearInterval(rotation.timer);
    rotation.timer = 0;
  }
}

function setupHouse(board) {
  const house = board.querySelector('[data-house]');
  if (!house) return;
  const slides = [...house.querySelectorAll('.house')];
  if (!slides.length) return;

  const show = (n) => {
    slides.forEach((s, k) => {
      const on = k === n;
      s.classList.toggle('is-active', on);
      if (on) {
        s.removeAttribute('aria-hidden');
        s.removeAttribute('tabindex');
      } else {
        s.setAttribute('aria-hidden', 'true');
        s.tabIndex = -1;
      }
    });
  };
  const first = Math.max(0, slides.findIndex((s) => s.classList.contains('is-active')));
  show(first);
  requestAnimationFrame(() => {
    house.dataset.ready = '';
  });

  if (slides.length < 2 || reduceMotion.matches) return;

  let onScreen = false;
  // with ads on, the promos are only up once AdSense has passed on the slot
  const showing = () => root.dataset.ads !== 'on' || board.dataset.state === 'house';
  const panel = { slides, first, show, held: false, live: () => onScreen && !document.hidden && showing() };
  rotation.panels.push(panel);

  new IntersectionObserver(([entry]) => {
    onScreen = entry.isIntersecting;
    syncRotation();
  }).observe(board);
  const hold = (on) => () => {
    panel.held = on;
    syncRotation();
  };
  board.addEventListener('pointerenter', hold(true));
  board.addEventListener('pointerleave', hold(false));
  board.addEventListener('focusin', hold(true));
  board.addEventListener('focusout', hold(false));
  board.addEventListener('billboardstate', syncRotation);
}

function setupAds(boards) {
  const units = [];

  // Can the panel show at its size? Below 336px the stylesheet lets a 320 or 300
  // wide panel run into the page gutters, which is fine while it stays on screen.
  // A panel that can't fit gets data-fit="no", which hides it.
  const place = (u) => {
    // measure at full size; nothing is painted in between
    const off = u.board.dataset.fit === 'no';
    if (off) delete u.board.dataset.fit;
    const frame = getComputedStyle(u.frame);
    const need = u.screen.offsetWidth + parseFloat(frame.paddingLeft) + parseFloat(frame.paddingRight);
    let ok = need <= u.board.clientWidth + 0.5;
    if (!ok && frame.maxWidth === 'none') {
      const r = u.frame.getBoundingClientRect();
      ok = r.left >= -0.5 && r.right <= document.documentElement.clientWidth + 0.5;
    }
    if (!ok) u.board.dataset.fit = 'no';
    return ok;
  };

  // AdSense draws a fixed-size creative for the size the slot had when it was
  // requested and never redraws it, so the screen is pinned to that size. If the
  // column later gets too narrow for it, the panel is hidden instead.
  const pin = (u) => {
    u.frame.style.setProperty('--ad-w', `${u.ins.offsetWidth}px`);
    u.frame.style.setProperty('--ad-h', `${u.ins.offsetHeight}px`);
    u.pinned = true;
  };
  const unpin = (u) => {
    u.pinned = false;
    u.frame.style.removeProperty('--ad-w');
    u.frame.style.removeProperty('--ad-h');
    delete u.board.dataset.fit;
  };

  const showHouse = (u) => {
    unpin(u);
    setState(u.board, 'house');
  };
  // Nothing will ever fill this slot (script blocked, or it never took the unit).
  // Drop the <ins> so a late script can't put an ad under the promo.
  const giveUp = (u) => {
    if (u.board.dataset.state) return;
    u.ins.remove();
    showHouse(u);
  };
  // adsbygoogle.js marks every unit it takes with data-adsbygoogle-status. The loader
  // is an async script, so by the window load event it has either run or failed; a
  // short grace period covers units pushed right before that.
  const check = (u) => {
    if (!u.ins.hasAttribute('data-adsbygoogle-status')) giveUp(u);
  };
  const settle = (u) => {
    const later = () => setTimeout(() => check(u), 1500);
    if (document.readyState === 'complete') later();
    else window.addEventListener('load', later, { once: true });
  };

  boards.forEach((board) => {
    const ins = board.querySelector('ins.billboard__ad');
    if (!ins) {
      setState(board, 'house');
      return;
    }
    // adsbygoogle.push({}) fills the next unprocessed <ins class="adsbygoogle"> in document
    // order, so units that are not on screen (the kiosk on a phone, the rail on a laptop)
    // drop the class until they actually have a size.
    ins.classList.remove('adsbygoogle');
    const unit = {
      board,
      ins,
      frame: board.querySelector('.billboard__frame'),
      screen: board.querySelector('.billboard__screen'),
      pushed: false,
      pinned: false,
    };
    units.push(unit);
    new MutationObserver(() => {
      const status = ins.getAttribute('data-ad-status');
      if (status === 'filled') setState(board, 'ad');
      else if (status === 'unfilled') showHouse(unit);
    }).observe(ins, { attributes: true, attributeFilter: ['data-ad-status'] });
  });
  if (!units.length) return;

  // Request a unit only once it is on the page and fits there, so a panel that would
  // be hidden is never filled; one that doesn't fit yet waits for a resize.
  const update = () => {
    for (const u of units) {
      if (u.pushed) {
        if (u.pinned) place(u);
        continue;
      }
      if (!u.board.offsetWidth || !place(u) || !u.ins.offsetWidth) continue;
      u.pushed = true;
      pin(u);
      u.ins.classList.add('adsbygoogle');
      try {
        (window.adsbygoogle = window.adsbygoogle || []).push({});
        settle(u);
      } catch {
        giveUp(u);
      }
    }
  };
  // Hiding or showing a panel resizes the very element being watched, so that
  // happens in the next frame rather than inside the observer callback.
  let queued = false;
  const watch = new ResizeObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      update();
    });
  });
  units.forEach((u) => watch.observe(u.board));
  update();
}

function initBillboards() {
  const boards = [...document.querySelectorAll('[data-billboard]')];
  if (!boards.length) return;
  boards.forEach(setupHouse);
  if (root.dataset.ads === 'on') setupAds(boards);
  document.addEventListener('visibilitychange', syncRotation);
}

/* Arrivals board (home) --------------------------------------------------- */

const TICK_MS = 4000;

function initArrivals() {
  const board = document.querySelector('[data-arrivals]');
  if (!board) return;
  const list = board.querySelector('[data-arrivals-list]');
  const source = board.querySelector('[data-arrivals-data]');
  if (!list || !source) return;

  let trains;
  try {
    trains = JSON.parse(source.textContent);
  } catch {
    return;
  }
  if (!Array.isArray(trains) || !trains.length) return;

  const label = (min) => (min <= 0 ? 'Due' : `${min} min`);
  const rows = [...list.children].map((el) => ({
    el,
    url: el.querySelector('a')?.getAttribute('href'),
    min: Number(el.dataset.min) || 0,
    due: 0,
  }));
  let next = rows.length % trains.length;

  const build = (train, min) => {
    const li = document.createElement('li');
    li.className = 'arrivals__row';
    li.innerHTML =
      `<a href="${esc(train.url)}">` +
      `<span class="bullet${train.shape === 'diamond' ? ' bullet--diamond' : ''}${train.dark ? ' bullet--dark-text' : ''}" style="--bullet: ${esc(train.color)}" aria-hidden="true">${esc(train.bullet)}</span>` +
      `<span class="arrivals__dest">${esc(train.title)}${train.sub ? ` <small>${esc(train.sub)}</small>` : ''}</span>` +
      `<span class="arrivals__min">${label(min)}</span></a>`;
    return { el: li, url: train.url, min, due: 0 };
  };

  const paint = (row) => {
    const min = row.el.querySelector('.arrivals__min');
    if (min) min.textContent = label(row.min);
    row.el.classList.toggle('is-due', row.min <= 0);
  };

  const depart = () => {
    const leaving = rows.shift();
    const animate = !reduceMotion.matches && typeof leaving.el.animate === 'function';
    const finish = () => {
      const before = rows.map((r) => r.el.getBoundingClientRect().top);
      const hadFocus = leaving.el.contains(document.activeElement);
      leaving.el.remove();
      if (hadFocus) rows[0]?.el.querySelector('a')?.focus({ preventScroll: true });

      // the next train in line is one that isn't already on the board
      let train = trains[next % trains.length];
      for (let i = 0; i < trains.length && rows.some((r) => r.url === train.url); i++) {
        next++;
        train = trains[next % trains.length];
      }
      next++;
      const last = rows[rows.length - 1]?.min ?? 0;
      const row = build(train, last + 2 + Math.floor(Math.random() * 4));
      rows.push(row);
      list.append(row.el);

      if (animate) {
        rows.forEach((r, k) => {
          const dy = (before[k] ?? 0) - r.el.getBoundingClientRect().top;
          if (k < before.length && dy) {
            r.el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 500, easing: 'cubic-bezier(.2,.7,.2,1)' });
          }
        });
        row.el.animate([{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }], { duration: 500, easing: 'ease-out' });
      }
    };
    if (animate) {
      leaving.el.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(-10px)' }], { duration: 400, easing: 'ease-in' }).finished.then(finish, finish);
    } else {
      finish();
    }
  };

  const tick = () => {
    const head = rows[0];
    if (head && head.min <= 0) {
      head.due++;
      if (head.due >= 2) {
        depart();
        return;
      }
    }
    rows.forEach((r) => {
      if (r.min > 0) r.min--;
      paint(r);
    });
  };

  let timer = 0;
  let onScreen = false;
  // hold the board still while someone is pointing at or tabbing through it, so a
  // row doesn't depart from under the cursor
  let held = false;
  const refresh = () => {
    const run = onScreen && !held && !document.hidden;
    if (run && !timer) timer = setInterval(tick, TICK_MS);
    if (!run && timer) {
      clearInterval(timer);
      timer = 0;
    }
  };
  new IntersectionObserver(([entry]) => {
    onScreen = entry.isIntersecting;
    refresh();
  }).observe(board);
  const hold = (on) => () => {
    held = on || board.matches(':hover') || board.contains(document.activeElement);
    refresh();
  };
  board.addEventListener('pointerenter', hold(true));
  board.addEventListener('pointerleave', hold(false));
  board.addEventListener('focusin', hold(true));
  board.addEventListener('focusout', (e) => {
    if (!board.contains(e.relatedTarget)) hold(false)();
  });
  document.addEventListener('visibilitychange', refresh);
}

/* Comments ----------------------------------------------------------------- */

function initComments() {
  const box = document.querySelector('[data-disqus]');
  if (!box) return;
  const button = box.querySelector('[data-disqus-load]');
  const load = () => {
    if (box.dataset.loaded) return;
    box.dataset.loaded = 'true';
    const url = box.dataset.url;
    window.disqus_config = function () {
      this.page.url = url;
    };
    const s = document.createElement('script');
    s.src = `https://${box.dataset.disqus}.disqus.com/embed.js`;
    s.async = true;
    s.setAttribute('data-timestamp', String(Date.now()));
    document.body.append(s);
    // the button is about to go; keep keyboard focus in the comments section
    const title = box.querySelector('#comments-title');
    if (title && button && button.contains(document.activeElement)) {
      title.tabIndex = -1;
      title.focus({ preventScroll: true });
    }
    button?.remove();
  };
  button?.addEventListener('click', load);
  if (/^#(comment|disqus)/.test(location.hash)) load();
}

/* Legacy WordPress smilies point at a server that no longer exists. */

const SMILIES = { ':roll:': '🙄', ':)': '🙂', ':-)': '🙂', ':D': '😀', ':(': '🙁', ';)': '😉', ':P': '😛', ':lol:': '😆', ':oops:': '😳', ':mrgreen:': '😁' };

function initSmilies() {
  document.querySelectorAll('.prose img.wp-smiley').forEach((img) => {
    const alt = img.getAttribute('alt') || '';
    const span = document.createElement('span');
    span.textContent = SMILIES[alt] || alt;
    span.setAttribute('role', 'img');
    span.setAttribute('aria-label', alt);
    img.replaceWith(span);
  });
}

/* Share bar on posts --------------------------------------------------------- */

function initShare() {
  document.querySelectorAll('[data-post-share]').forEach((el) => {
    const title = el.dataset.shareTitle || document.title;
    mountShareBar(el, { url: el.dataset.shareUrl || location.href, title, text: title });
  });
}

for (const init of [initTheme, initMenu, initClock, initBillboards, initArrivals, initComments, initSmilies, initShare]) {
  try {
    init();
  } catch (err) {
    console.warn(err);
  }
}
