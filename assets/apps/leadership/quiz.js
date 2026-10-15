// One question per screen. Items are shown in ITEM_ORDER but answers are stored in ITEMS
// order, which is what scoring.js and the leaderboard expect.

import { ITEMS, ITEM_ORDER, ITEM_INDEX } from './scoring.js';
import { fill, escapeHtml } from './i18n.js';

const TOTAL = ITEM_ORDER.length;
const LETTERS = ['A', 'B', 'C', 'D'];
const STATIONS = ITEM_ORDER.map((id, i) => (ITEMS[ITEM_INDEX[id]].type === 'sjt' ? i : -1)).filter((i) => i >= 0);

// Rough reading time, used only for the "minutes left" line.
const SECONDS = { likert: 6, attention: 6, sjt: 20 };

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const finePointer = () => window.matchMedia?.('(hover: hover) and (pointer: fine)').matches;

const ICON_BACK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5m5-5-5 5 5 5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_NEXT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_EXIT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
const ICON_SAVED = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.2 4.2L19 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function createQuiz(view, { t, state, onSave, onFinish, onExit }) {
  const q = t.ui.quiz;
  let pos = Math.min(Math.max(0, state.pos || 0), TOTAL - 1);
  let pending = 0;
  let clock = null;
  let active = false;

  view.innerHTML = `<div class="container lq-quiz">
  <div class="lq-quiz__bar">
    <div class="lq-progress">
      <div class="lq-progress__meta">
        <span class="lq-progress__count" data-count></span>
        <span class="lq-progress__eta" data-eta></span>
      </div>
      <div class="lq-progress__track" role="progressbar" aria-valuemin="0" aria-valuemax="${TOTAL}" data-track>
        <span class="lq-progress__rail"></span>
        <span class="lq-progress__fill" data-fill></span>
        ${STATIONS.map((i) => `<span class="lq-progress__stop" style="--at:${(i / TOTAL) * 100}%" data-stop="${i}"></span>`).join('')}
        <span class="lq-progress__stop lq-progress__stop--end" style="--at:100%"></span>
        <span class="lq-progress__train" data-train aria-hidden="true">1</span>
      </div>
    </div>
    <button class="lq-quiz__exit" type="button" data-exit>${ICON_EXIT}<span>${escapeHtml(q.exit)}</span></button>
  </div>
  <div class="lq-stage" data-stage></div>
  <div class="lq-quiz__nav">
    <button class="btn btn--ghost lq-quiz__back" type="button" data-back>${ICON_BACK}<span>${escapeHtml(q.back)}</span></button>
    <p class="lq-quiz__hint" data-hint></p>
    <button class="btn btn--primary lq-quiz__next" type="button" data-next><span data-next-label></span>${ICON_NEXT}</button>
  </div>
  <p class="lq-quiz__saved">${ICON_SAVED}<span>${escapeHtml(q.saved)}</span></p>
</div>`;

  const $ = (sel) => view.querySelector(sel);
  const stage = $('[data-stage]');
  const track = $('[data-track]');
  const backBtn = $('[data-back]');
  const nextBtn = $('[data-next]');

  // Time only counts while the question screen is on screen.
  const tick = () => {
    if (clock === null) return;
    const now = performance.now();
    state.elapsed = (state.elapsed || 0) + (now - clock);
    clock = now;
  };
  const startClock = () => {
    if (active && clock === null && !document.hidden) clock = performance.now();
  };
  const stopClock = () => {
    tick();
    clock = null;
  };

  const save = () => {
    tick();
    state.pos = pos;
    onSave(state);
  };

  const answerAt = (i) => state.answers[ITEM_INDEX[ITEM_ORDER[i]]];
  const isAnswered = (i) => answerAt(i) !== null && answerAt(i) !== undefined;
  const firstOpen = () => ITEM_ORDER.findIndex((_, i) => !isAnswered(i));

  function etaText() {
    let secs = 0;
    let left = 0;
    for (let i = pos; i < TOTAL; i++) {
      if (isAnswered(i) && i !== pos) continue;
      left++;
      secs += SECONDS[ITEMS[ITEM_INDEX[ITEM_ORDER[i]]].type] || 6;
    }
    if (left <= 5) return q.almost_there;
    const min = Math.ceil(secs / 60);
    return min <= 1 ? q.time_left_short : fill(q.time_left, { min });
  }

  function updateChrome() {
    const n = pos + 1;
    const count = $('[data-count]');
    count.innerHTML = `<span class="lq-long">${escapeHtml(fill(q.progress, { n, total: TOTAL }))}</span><span class="lq-short">${escapeHtml(fill(q.progress_short, { n, total: TOTAL }))}</span>`;
    $('[data-eta]').textContent = etaText();
    const at = (pos / TOTAL) * 100;
    track.style.setProperty('--progress', `${at}%`);
    track.setAttribute('aria-valuenow', String(pos));
    track.setAttribute('aria-valuetext', fill(q.progress, { n, total: TOTAL }));
    view.querySelectorAll('[data-stop]').forEach((s) => s.classList.toggle('is-passed', +s.dataset.stop < pos));

    backBtn.disabled = pos === 0;
    const done = firstOpen() === -1;
    const last = pos === TOTAL - 1;
    nextBtn.disabled = !isAnswered(pos);
    nextBtn.classList.toggle('lq-quiz__next--finish', last && done);
    $('[data-next-label]').textContent = last && done ? q.finish : q.next;

    const it = ITEMS[ITEM_INDEX[ITEM_ORDER[pos]]];
    $('[data-hint]').textContent = finePointer() ? (it.type === 'sjt' ? q.keyboard_hint_options : q.keyboard_hint_scale) : '';
  }

  function questionHtml() {
    const id = ITEM_ORDER[pos];
    const it = ITEMS[ITEM_INDEX[id]];
    const val = answerAt(pos);
    const tid = `lq-q-${id}`;

    if (it.type === 'sjt') {
      const s = t.sjt[id];
      const opts = s.options
        .map((o, i) => `<button class="lq-option" type="button" data-value="${i}" aria-pressed="${val === i}"><span class="lq-option__key" aria-hidden="true">${LETTERS[i]}</span><span class="lq-option__text">${escapeHtml(o)}</span></button>`)
        .join('');
      return `<div class="lq-q lq-q--scenario">
  <p class="lq-q__kicker"><span class="lq-q__tag">${escapeHtml(q.scenario_label)}</span><span class="lq-q__title">${escapeHtml(s.title)}</span></p>
  <h2 class="lq-q__text lq-q__text--stem" id="${tid}" tabindex="-1">${escapeHtml(s.stem)}</h2>
  <p class="lq-q__prompt">${escapeHtml(q.scenario_prompt)}</p>
  <div class="lq-options" role="group" aria-labelledby="${tid}">${opts}</div>
</div>`;
    }

    const labels = t.scale.labels;
    const text = it.type === 'attention'
      ? fill(t.attention[id], { label: labels[it.expect - 1] })
      : t.items[id];
    const kicker = it.type === 'attention'
      ? `<span class="lq-q__tag lq-q__tag--check">${escapeHtml(q.attention_label)}</span>`
      : escapeHtml(q.statement_prompt);
    const opts = labels
      .map((l, i) => `<button class="lq-scale__opt" type="button" data-value="${i + 1}" aria-pressed="${val === i + 1}"><span class="lq-scale__dot" aria-hidden="true">${i + 1}</span><span class="lq-scale__label">${escapeHtml(l)}</span></button>`)
      .join('');
    return `<div class="lq-q lq-q--statement">
  <p class="lq-q__kicker">${kicker}</p>
  <h2 class="lq-q__text" id="${tid}" tabindex="-1">${escapeHtml(text)}</h2>
  <div class="lq-scale" role="group" aria-labelledby="${tid}">${opts}</div>
</div>`;
  }

  function render(dir = 0, focus = true, snap = false) {
    stage.innerHTML = questionHtml();
    const el = stage.firstElementChild;
    updateChrome();
    if (dir && !reducedMotion() && el.animate) {
      el.animate(
        [
          { opacity: 0, transform: `translateX(${dir * 28}px)` },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 260, easing: 'cubic-bezier(.2,.7,.2,1)' },
      );
    }
    // Keep the question in view; on a phone, start with it at the top of the screen.
    const top = view.getBoundingClientRect().top;
    if (top < -8 || top > window.innerHeight * 0.5 || (snap && top > 24 && window.innerWidth < 600)) {
      view.scrollIntoView({ block: 'start', behavior: snap || reducedMotion() ? 'auto' : 'smooth' });
    }
    if (focus) el.querySelector('.lq-q__text')?.focus({ preventScroll: true });
  }

  function go(next, dir) {
    clearTimeout(pending);
    pending = 0;
    if (next < 0 || next >= TOTAL || next === pos) return;
    pos = next;
    save();
    render(dir);
  }

  function finish() {
    clearTimeout(pending);
    pending = 0;
    save();
    stopClock();
    active = false;
    onFinish(state);
  }

  function advance() {
    if (pos < TOTAL - 1) return go(pos + 1, 1);
    const open = firstOpen();
    if (open === -1) return finish();
    return go(open, open > pos ? 1 : -1);
  }

  function answer(value) {
    const idx = ITEM_INDEX[ITEM_ORDER[pos]];
    tick();
    state.answers[idx] = value;
    state.durationMs = Math.round(state.elapsed || 0);
    stage.querySelectorAll('[data-value]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.value === value)));
    save();
    updateChrome();
    clearTimeout(pending);
    pending = setTimeout(advance, reducedMotion() ? 140 : 280);
  }

  stage.addEventListener('click', (e) => {
    const b = e.target.closest('[data-value]');
    if (b) answer(+b.dataset.value);
  });
  backBtn.addEventListener('click', () => go(pos - 1, -1));
  nextBtn.addEventListener('click', () => {
    if (isAnswered(pos)) advance();
  });
  $('[data-exit]').addEventListener('click', () => {
    clearTimeout(pending);
    pending = 0;
    save();
    onExit();
  });

  function onKey(e) {
    if (!active || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    const it = ITEMS[ITEM_INDEX[ITEM_ORDER[pos]]];
    const k = e.key;

    if (it.type === 'sjt') {
      const i = /^[1-4]$/.test(k) ? +k - 1 : 'abcd'.indexOf(k.toLowerCase());
      if (k.length === 1 && i >= 0) {
        e.preventDefault();
        return answer(i);
      }
    } else if (/^[1-5]$/.test(k)) {
      e.preventDefault();
      return answer(+k);
    }

    if (k === 'Backspace' || k === 'ArrowLeft') {
      e.preventDefault();
      return go(pos - 1, -1);
    }
    if (k === 'ArrowRight' || (k === 'Enter' && !e.target.closest?.('button, a'))) {
      if (isAnswered(pos)) {
        e.preventDefault();
        advance();
      }
      return;
    }
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      const opts = [...stage.querySelectorAll('[data-value]')];
      if (!opts.length) return;
      e.preventDefault();
      const cur = opts.indexOf(document.activeElement);
      const sel = opts.findIndex((b) => b.getAttribute('aria-pressed') === 'true');
      const from = cur >= 0 ? cur : sel >= 0 ? sel : k === 'ArrowDown' ? -1 : opts.length;
      const next = Math.max(0, Math.min(opts.length - 1, from + (k === 'ArrowDown' ? 1 : -1)));
      opts[next].focus();
    }
  }

  const onVisibility = () => {
    if (document.hidden) {
      stopClock();
      save();
    } else {
      startClock();
    }
  };
  const onPageHide = () => {
    if (active) save();
  };

  document.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);

  return {
    show({ focus = true } = {}) {
      active = true;
      const open = firstOpen();
      if (open !== -1 && open < pos) pos = open;
      render(0, focus, true);
      startClock();
    },
    hide() {
      if (active) save();
      active = false;
      stopClock();
      clearTimeout(pending);
      pending = 0;
    },
    destroy() {
      this.hide();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      view.textContent = '';
    },
  };
}
