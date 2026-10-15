// LQ Test page controller. Three screens share the page: the landing (rendered by Jekyll),
// the questions (#test) and the result (#result). Progress and the last result live in
// localStorage, so a reload or a closed tab picks up where it left off.

import { ITEMS, ARCHETYPE_IDS, scoreAnswers, decodeResult, pctFromLq } from './scoring.js';
import { loadStrings, makeFormat, fill, escapeHtml } from './i18n.js';
import { loadProgress, saveProgress, clearProgress, answeredCount, loadLast, saveLast, loadShared, saveShared } from './store.js';
import { createQuiz } from './quiz.js';
import { renderResult, loadBoard } from './result.js';
import { radarSvg } from './charts.js';
import { archetypeIconSvg } from './icons.js';
import { toast } from '/assets/js/lib/share.js';

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const root = document.querySelector('[data-lq]');
if (root) boot(root);

function boot(root) {
  const t = loadStrings();
  if (!t.ui || !t.items) return;
  const fmt = makeFormat(t);
  const lang = root.dataset.lang || 'en';
  const shareUrl = (root.dataset.shareUrl || `${location.origin}${location.pathname}`).split(/[?#]/)[0];
  const baseTitle = document.title;

  const views = Object.fromEntries([...root.querySelectorAll('[data-view]')].map((v) => [v.dataset.view, v]));
  let quiz = null;
  let current = null;
  let cameFromLanding = false;
  let loadingTimer = 0;
  // The finished test, kept in memory too: with storage blocked, saveLast() silently does
  // nothing, and the result screen still has to show something.
  let lastMem = null;
  const currentLast = () => loadLast() || lastMem;
  const rememberLast = (l) => {
    lastMem = l;
    saveLast(l);
  };

  // ---- shared links -------------------------------------------------------------------
  const param = new URLSearchParams(location.search).get('r');
  const shared = param ? decodeResult(param) : null;
  if (shared) saveShared(param);
  const sessionShared = shared || (loadShared() ? decodeResult(loadShared().code) : null);

  function renderSharedBanner() {
    const el = root.querySelector('[data-shared]');
    if (!el || !param) return;
    const R = t.ui.result;
    if (!shared) {
      el.innerHTML = `<p class="lq-shared__bad">${escapeHtml(R.shared_invalid)}</p>`;
      el.hidden = false;
      return;
    }
    const arch = t.archetypes[shared.archetype];
    el.innerHTML = `<div class="lq-shared__card">
  <div class="lq-shared__score" aria-hidden="true"><span class="lq-shared__lq">LQ</span><span class="lq-shared__num">${shared.lq}</span></div>
  <div class="lq-shared__text">
    <p class="lq-shared__kicker">${escapeHtml(R.shared_kicker)}</p>
    <h2 class="lq-shared__title">${escapeHtml(fill(R.shared_headline, { lq: shared.lq }))}<span>${archetypeIconSvg(shared.archetype, 'lq-mark lq-mark--sm')}${escapeHtml(arch.name)}</span></h2>
    <p class="lq-shared__pct">${escapeHtml(fill(t.templates.percentile, { pct: fmt.pct(shared.percentile) }))}</p>
    <a class="btn btn--primary lq-btn-go" href="#test" data-start>${escapeHtml(R.shared_cta)}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></a>
    <p class="lq-shared__note">${escapeHtml(R.shared_note)}</p>
  </div>
  <div class="lq-shared__radar">${radarSvg(shared.dims, null, { size: 150 })}</div>
</div>`;
    el.hidden = false;
    // Keep the friend's result when switching language.
    root.querySelectorAll('[data-lang-link]').forEach((a) => {
      a.href = `${a.getAttribute('href').split('?')[0]}?r=${encodeURIComponent(param)}`;
    });
  }

  // ---- landing --------------------------------------------------------------------------
  function refreshLanding() {
    const p = loadProgress();
    const n = answeredCount(p);
    // A fully answered set that never reached the result (Back pressed on the last
    // question, then reload or Exit) is still resumable: the last screen offers Finish.
    const inProgress = n > 0;
    root.querySelector('[data-cta]').hidden = inProgress;
    const resume = root.querySelector('[data-resume]');
    resume.hidden = !inProgress;
    if (inProgress) resume.querySelector('[data-resume-bar]').style.width = `${(n / ITEMS.length) * 100}%`;

    const last = currentLast();
    const link = root.querySelector('[data-last]');
    if (last) {
      const r = scoreAnswers(last.answers, { durationMs: last.durationMs });
      link.innerHTML = `${archetypeIconSvg(r.archetype, 'lq-mark lq-mark--xs')}<span>${escapeHtml(fill(t.templates.headline, { lq: r.lq }))}</span><span class="lq-last__arch">${escapeHtml(t.archetypes[r.archetype].name)}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      link.hidden = false;
    } else {
      link.hidden = true;
    }
  }

  function startDemo() {
    const board = root.querySelector('[data-demo]');
    if (!board || reducedMotion()) return;
    const num = board.querySelector('[data-demo-lq]');
    const pct = board.querySelector('[data-demo-pct]');
    const archEl = board.querySelector('[data-demo-arch]');
    const marker = board.querySelector('[data-demo-marker]');
    const samples = [
      [112, 'strategist'], [127, 'commander'], [96, 'coach'], [134, 'visionary'],
      [105, 'connector'], [119, 'anchor'], [101, 'catalyst'], [124, 'maverick'], [109, 'allrounder'],
    ].filter(([, a]) => ARCHETYPE_IDS.includes(a));
    let i = 0;
    let visible = true;

    const show = ([lq, arch]) => {
      let n = 0;
      const scramble = setInterval(() => {
        num.textContent = String(55 + Math.floor(Math.random() * 90));
        if (++n >= 7) {
          clearInterval(scramble);
          num.textContent = String(lq);
          pct.textContent = fill(t.ui.result.pct_value, { pct: fmt.pct(pctFromLq(lq)) });
          archEl.textContent = t.archetypes[arch].name;
          marker.style.left = `${((lq - 55) / 90) * 100}%`;
        }
      }, 55);
    };
    const loop = () => {
      if (visible && !document.hidden && current === 'landing') show(samples[i++ % samples.length]);
      setTimeout(loop, 3400);
    };
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((entries) => {
        visible = entries[0].isIntersecting;
      }).observe(board);
    }
    setTimeout(loop, 700);
  }

  // ---- screens ------------------------------------------------------------------------
  function show(name) {
    if (current === 'quiz' && name !== 'quiz') quiz?.hide();
    for (const [k, v] of Object.entries(views)) v.hidden = k !== name;
    root.dataset.screen = name;
    current = name;
    if (name !== 'result' && name !== 'loading') document.title = baseTitle;
  }

  function newProgress() {
    return { answers: new Array(ITEMS.length).fill(null), pos: 0, elapsed: 0, durationMs: 0, started: Date.now() };
  }

  function openQuiz({ fresh = false } = {}) {
    quiz?.destroy();
    let p = fresh ? null : loadProgress();
    if (!p) p = newProgress();
    saveProgress(p);
    quiz = createQuiz(views.quiz, {
      t,
      state: p,
      onSave: saveProgress,
      onFinish: finish,
      onExit: () => {
        toLanding();
        toast(t.ui.quiz.saved);
      },
    });
    show('quiz');
    quiz.show();
  }

  function finish(state) {
    const durationMs = Math.max(1, Math.round(state.durationMs || state.elapsed || 0));
    const answers = state.answers.slice();
    rememberLast({ answers, durationMs, lang, ts: Date.now(), posted: null });
    clearProgress();
    quiz?.destroy();
    quiz = null;
    history.replaceState(history.state, '', `${location.pathname}${location.search}#result`);
    showLoading(() => openResult({ animate: true }));
  }

  function showLoading(done) {
    const L = t.ui.loading;
    const v = views.loading;
    v.innerHTML = `<div class="container lq-loading">
  <div class="lq-loading__board" role="status" aria-live="polite">
    <p class="lq-loading__next"><span class="bullet bullet--sm" style="--bullet: var(--line-red)" aria-hidden="true">1</span>${escapeHtml(L.title)}</p>
    <ol class="lq-loading__steps">${L.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>
    <p class="lq-loading__doors">${escapeHtml(L.doors)}</p>
  </div>
  <div class="lq-doors" aria-hidden="true"><span></span><span></span></div>
</div>`;
    show('loading');
    v.scrollIntoView({ block: 'start', behavior: 'auto' });
    const steps = [...v.querySelectorAll('.lq-loading__steps li')];
    const fast = reducedMotion();
    const per = fast ? 120 : 430;
    steps.forEach((li, i) => setTimeout(() => li.classList.add('is-done'), per * (i + 1)));
    const closeAt = per * (steps.length + 1);
    if (!fast) setTimeout(() => v.querySelector('.lq-loading').classList.add('is-closing'), closeAt);
    clearTimeout(loadingTimer);
    loadingTimer = setTimeout(done, closeAt + (fast ? 200 : 700));
  }

  function openResult({ animate = false } = {}) {
    const last = currentLast();
    if (!last) {
      history.replaceState(history.state, '', `${location.pathname}${location.search}`);
      return route();
    }
    const r = scoreAnswers(last.answers, { durationMs: last.durationMs });
    const arriving = animate && !reducedMotion();
    renderResult(views.result, {
      t,
      fmt,
      lang,
      shareUrl,
      last,
      r,
      shared: sessionShared,
      // Hold the count-up until the doors are about halfway open, so it plays in view.
      revealDelay: arriving ? 600 : 0,
      onSaveLast: rememberLast,
      onRetake: () => enterQuiz(true),
    });
    show('result');
    views.result.classList.toggle('is-arriving', arriving);
    if (arriving) {
      // The doors that closed on the loading screen open again on the result.
      const doors = document.createElement('div');
      doors.className = 'lq-doors lq-doors--reveal';
      doors.setAttribute('aria-hidden', 'true');
      doors.innerHTML = '<span></span><span></span>';
      views.result.prepend(doors);
      requestAnimationFrame(() => requestAnimationFrame(() => doors.classList.add('is-open')));
      setTimeout(() => doors.remove(), 1400);
    }
    views.result.scrollIntoView({ block: 'start', behavior: 'auto' });
    views.result.querySelector('#lq-r-title')?.focus({ preventScroll: true });
  }

  function toLanding() {
    if (cameFromLanding) {
      cameFromLanding = false;
      history.back();
      return;
    }
    history.replaceState(history.state, '', `${location.pathname}${location.search}`);
    route();
  }

  function landing() {
    clearTimeout(loadingTimer);
    show('landing');
    refreshLanding();
    loadBoard(root.querySelector('[data-board-landing]'), t);
  }

  function route() {
    const h = location.hash;
    if (h === '#test') {
      if (current !== 'quiz') openQuiz();
    } else if (h === '#result') {
      if (current !== 'result' && current !== 'loading') openResult();
    } else if (!h || h === '#' || current === null) {
      // Any other hash is an in-page anchor (#science, #main): stay on the current screen.
      if (current !== 'landing') landing();
    }
  }

  // ---- events -------------------------------------------------------------------------
  const enterQuiz = (fresh) => {
    cameFromLanding = current === 'landing';
    // A retake replaces the result entry; pushing would leave a dead #result behind it,
    // and Back would seem to do nothing once per retake.
    const url = `${location.pathname}${location.search}#test`;
    if (current === 'result') history.replaceState(history.state, '', url);
    else history.pushState(history.state, '', url);
    openQuiz({ fresh });
  };

  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-start]')) {
      e.preventDefault();
      return enterQuiz(answeredCount(loadProgress()) === 0);
    }
    if (e.target.closest('[data-resume-btn]')) return enterQuiz(false);
    if (e.target.closest('[data-restart]')) return enterQuiz(true);
    if (e.target.closest('[data-last]')) {
      e.preventDefault();
      history.pushState(history.state, '', `${location.pathname}${location.search}#result`);
      return openResult();
    }
    const anchor = e.target.closest('a[href="#science"]');
    if (anchor) {
      e.preventDefault();
      document.getElementById('science')?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth' });
    }
  });

  window.addEventListener('hashchange', route);
  window.addEventListener('popstate', route);

  renderSharedBanner();
  route();
  startDemo();
}
