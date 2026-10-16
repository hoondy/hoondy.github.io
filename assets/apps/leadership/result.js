// Result screen: score board, archetype, traits, strengths and growth, sharing, and where the
// score lands among everyone else's.

import { DIM_IDS, LQ_MIN, encodeResult } from './scoring.js';
import { fill, escapeHtml, sentenceGap } from './i18n.js';
import { radarSvg, bellSvg, gaugeSvg } from './charts.js';
import { archetypeIconSvg } from './icons.js';
import { renderPoster } from './poster.js';
import { mountDistribution } from './dist.js';
import { contribute } from './stats.js';
import { mountShareBar, toast, canNativeShare, nativeShare, copyText } from '/assets/js/lib/share.js';

let posterUrl = '';
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const coarsePointer = () => window.matchMedia?.('(pointer: coarse)').matches;

const ICON_ALERT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 2.5 20h19L12 3.5Z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><path d="M12 10v4.5" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/><circle cx="12" cy="17.3" r="1.2" fill="currentColor"/></svg>';
const ICON_RETAKE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v3.8h3.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_SHARE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_UP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_VS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h15m-4-4 4 4-4 4M20 16H5m4-4-4 4 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_CHART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h16M6.5 17v-4m4 4V8m4 9v-6.5m4 6.5v-3" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
const ICON_OK = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="m8.2 12.2 2.6 2.6 5-5.3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M8 12h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ICON_GROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20v-8m0 2c0-4 2.7-6.6 7-6.6 0 4.1-2.8 6.6-7 6.6Zm0 2c0-3.3-2.4-5.5-6.2-5.5 0 3.3 2.4 5.5 6.2 5.5Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

function countUp(el, to, delay = 0) {
  if (reducedMotion()) {
    el.textContent = String(to);
    return;
  }
  const from = LQ_MIN;
  const dur = 1100;
  // Timed from the first frame, so a frame stamped before the call can't push it below 55.
  let start = 0;
  const step = (now) => {
    if (!start) start = now;
    const k = Math.min(1, Math.max(0, (now - start) / dur));
    const e = 1 - (1 - k) ** 3;
    el.textContent = String(Math.round(from + (to - from) * e));
    if (k < 1) requestAnimationFrame(step);
  };
  el.textContent = String(from);
  setTimeout(() => requestAnimationFrame(step), delay);
}

/**
 * ctx: { t, fmt, lang, shareUrl, last, r, shared, revealDelay, onRetake, onSaveLast }
 * `r` is scoreAnswers() output for `last.answers`; `shared` a decoded friend's result or null.
 */
export function renderResult(view, ctx) {
  const { t, fmt, lang, r, last, shared } = ctx;
  const R = t.ui.result;
  const D = t.ui.distribution;
  const arch = t.archetypes[r.archetype];
  const band = t.bands[r.band];
  const pct = fmt.pct(r.percentile);
  const dimName = (id) => t.dimensions[id].name;
  const dimShort = (id) => t.dimensions[id].short || t.dimensions[id].name;
  const dimPct = Object.fromEntries(DIM_IDS.map((id) => [id, r.dims[id].percentile]));
  const code = encodeResult(r);
  const shortLabels = Object.fromEntries(DIM_IDS.map((id) => [id, dimShort(id)]));

  const validity = r.valid
    ? ''
    : `<section class="lq-alert" aria-labelledby="lq-alert-title">
  <span class="lq-alert__icon">${ICON_ALERT}</span>
  <div class="lq-alert__body">
    <h2 id="lq-alert-title">${escapeHtml(R.validity_title)}</h2>
    <p>${escapeHtml(R.validity_body)}</p>
    <p class="lq-alert__reasons">${escapeHtml(R.validity_reasons)}</p>
    <ul>${r.flags.map((f) => `<li>${escapeHtml(t.ui.validity[f] || '')}</li>`).join('')}</ul>
    <button class="btn btn--sm lq-alert__retake" type="button" data-retake>${ICON_RETAKE}<span>${escapeHtml(R.retake)}</span></button>
  </div>
</section>`;

  const gap = shared ? r.lq - shared.lq : 0;
  const verdict = !shared ? '' : gap > 0 ? fill(R.vs_ahead, { n: gap }) : gap < 0 ? fill(R.vs_behind, { n: -gap }) : R.vs_tie;
  const vs = shared
    ? `<p class="lq-vs"><span class="lq-vs__chip">${escapeHtml(fill(R.shared_headline, { lq: shared.lq }))}</span><span>${escapeHtml(t.archetypes[shared.archetype]?.name || '')}</span><strong class="lq-vs__verdict">${escapeHtml(verdict)}</strong></p>`
    : '';

  const traitRows = DIM_IDS.map((id) => {
    const d = t.dimensions[id];
    const p = r.dims[id].percentile;
    const hi = p >= 50;
    return `<li class="lq-trait${hi ? ' is-high' : ''}">
  <details>
    <summary>
      <span class="lq-trait__name">${escapeHtml(d.name)}<small>${escapeHtml(d.tagline)}</small></span>
      <span class="lq-trait__meter" role="img" aria-label="${escapeHtml(fill(R.trait_value_aria, { trait: d.name, pct: p }))}"><span class="lq-trait__fill" style="--v:${p}%"></span></span>
      <span class="lq-trait__value" aria-hidden="true">${escapeHtml(fill(R.trait_value, { pct: p }))}</span>
      <svg class="lq-trait__chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </summary>
    <div class="lq-trait__more">
      <p><span class="lq-trait__level">${escapeHtml(hi ? R.trait_high : R.trait_low)}</span>${escapeHtml(hi ? d.high : d.low)}</p>
      <p class="lq-trait__tip"><strong>${escapeHtml(R.try_this)}</strong>${escapeHtml(d.tip)}</p>
    </div>
  </details>
</li>`;
  }).join('');

  // Strengths and growth are picked by rank within the profile, so a "strength" can still sit
  // below average (and a growth area above it). The high/low descriptions only fit when the
  // level agrees; otherwise say what the ranking means.
  const focusText = (id, side) => {
    const d = t.dimensions[id];
    const hi = r.dims[id].percentile >= 50;
    if (side === 'up') return hi ? d.high : R.strength_relative;
    return hi ? R.growth_relative : d.low;
  };
  const strengths = r.strengths
    .map((id) => `<li><h3><span class="lq-focus__pct">${r.dims[id].percentile}</span>${escapeHtml(dimName(id))}</h3><p>${escapeHtml(focusText(id, 'up'))}</p></li>`)
    .join('');
  const growth = r.growth
    .map((id) => `<li><h3><span class="lq-focus__pct">${r.dims[id].percentile}</span>${escapeHtml(dimName(id))}</h3><p>${escapeHtml(focusText(id, 'grow'))}</p><p class="lq-focus__tip"><strong>${escapeHtml(R.try_this)}</strong>${escapeHtml(t.dimensions[id].tip)}</p></li>`)
    .join('');

  const legend = shared
    ? `<p class="lq-legend"><span class="lq-legend__you">${escapeHtml(R.legend_you)}</span><span class="lq-legend__them">${escapeHtml(fill(R.shared_headline, { lq: shared.lq }))}</span></p>`
    : '';

  view.innerHTML = `<div class="container lq-result">
${validity}
<section class="lq-r-hero" aria-labelledby="lq-r-title">
  <div class="lq-r-board">
    <div class="lq-r-board__head"><span>${escapeHtml(R.lq_label)}</span><span class="lq-r-board__band">${escapeHtml(band.label)}</span></div>
    <p class="lq-r-board__num"><span class="visually-hidden">${escapeHtml(fill(t.templates.headline, { lq: r.lq }))}</span><span aria-hidden="true" data-lq-num>${r.lq}</span></p>
    <div class="lq-r-board__foot"><span>${escapeHtml(band.line)}</span><span>${escapeHtml(band.range)}</span></div>
  </div>
  <div class="lq-r-intro">
    <p class="lq-kicker"><span class="bullet bullet--sm" style="--bullet: var(--line-red)" aria-hidden="true">1</span><span>${escapeHtml(R.kicker)}</span></p>
    <h2 class="lq-r-title" id="lq-r-title" tabindex="-1">${escapeHtml(fill(R.pct_sentence, { pct }))}</h2>
    ${bellSvg(r.lq)}
    <p class="lq-r-scale">${escapeHtml(R.lq_scale)}</p>
    <div class="lq-r-stats">
      <div class="lq-stat">
        <span class="lq-stat__label">${escapeHtml(R.pct_label)}</span>
        <span class="lq-stat__value">${escapeHtml(fill(R.pct_value, { pct }))}</span>
      </div>
      <div class="lq-stat lq-stat--gauge">
        ${gaugeSvg(r.emergence)}
        <span class="lq-stat__label">${escapeHtml(R.emergence_label)}</span>
        <span class="lq-stat__value">${escapeHtml(fill(R.emergence_value, { chance: r.emergence }))}</span>
      </div>
    </div>
    <p class="lq-r-note">${escapeHtml(fill(R.emergence_sentence, { chance: r.emergence }))}</p>
    ${vs}
    <div class="lq-r-jump">
      <button class="btn btn--primary btn--sm lq-btn-go" type="button" data-jump="lq-share-title">${ICON_SHARE}<span>${escapeHtml(t.ui.share.share)}</span></button>
      <button class="btn btn--ghost btn--sm" type="button" data-jump="lq-dist-title">${ICON_CHART}<span>${escapeHtml(D.title)}</span></button>
    </div>
  </div>
</section>

<section class="lq-arch" aria-labelledby="lq-arch-name">
  <header class="lq-arch__head">
    ${archetypeIconSvg(r.archetype, 'lq-mark lq-mark--lg')}
    <div>
      <p class="lq-arch__label">${escapeHtml(R.archetype_label)}</p>
      <h2 class="lq-arch__name" id="lq-arch-name">${escapeHtml(arch.name)}</h2>
      <p class="lq-arch__tagline">${escapeHtml(arch.tagline)}</p>
    </div>
  </header>
  <div class="lq-arch__body">
    <div class="lq-arch__summary">
      <h3 class="visually-hidden">${escapeHtml(R.summary_title)}</h3>
      <p>${escapeHtml(arch.summary)}</p>
      <p class="lq-arch__sum2">${escapeHtml(fill(t.templates.summary, { lq: r.lq, pct, archetype: arch.name }))}</p>
    </div>
    <div class="lq-arch__lists">
      <div><h3>${escapeHtml(R.strengths_list_title)}</h3><ul class="lq-arch__plus">${arch.strengths.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul></div>
      <div><h3>${escapeHtml(R.watchouts_title)}</h3><ul class="lq-arch__minus">${arch.watchouts.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul></div>
    </div>
  </div>
  <p class="lq-arch__motto"><span>${escapeHtml(R.motto_label)}</span>${escapeHtml(arch.motto)}</p>
</section>

<section class="lq-r-traits" aria-labelledby="lq-traits-title">
  <header class="lq-r-head">
    <h2 class="lq-section-title" id="lq-traits-title">${escapeHtml(R.traits_title)}</h2>
    <p>${escapeHtml(R.traits_note)}</p>
  </header>
  <div class="lq-traits">
    <figure class="lq-traits__radar">
      ${radarSvg(dimPct, shortLabels, { compare: shared?.dims || null, cls: 'lq-radar--wide' })}
      ${radarSvg(dimPct, shortLabels, { compare: shared?.dims || null, cls: 'lq-radar--narrow', size: 240, font: 18, showValues: false })}
      ${legend}
    </figure>
    <ul class="lq-traits__list">${traitRows}</ul>
  </div>
</section>

<section class="lq-r-focus">
  <div class="lq-focus lq-focus--up">
    <h2 class="lq-focus__title"><span class="lq-focus__icon">${ICON_UP}</span>${escapeHtml(R.strengths_title)}</h2>
    <ol>${strengths}</ol>
  </div>
  <div class="lq-focus lq-focus--grow">
    <h2 class="lq-focus__title"><span class="lq-focus__icon">${ICON_GROW}</span>${escapeHtml(R.growth_title)}</h2>
    <ol>${growth}</ol>
    <p class="lq-focus__note">${escapeHtml(R.growth_note)}</p>
  </div>
</section>

<div class="lq-r-social">
  <section class="lq-share" aria-labelledby="lq-share-title">
    <h2 class="lq-section-title" id="lq-share-title">${escapeHtml(R.share_title)}</h2>
    <p class="lq-share__note">${escapeHtml(R.share_note)}</p>
    <div class="lq-share__body">
      <figure class="lq-share__poster" data-poster><span class="lq-share__ph"></span></figure>
      <div class="lq-share__side">
        <div class="lq-share__bar" data-sharebar></div>
        <button class="btn btn--ghost btn--sm lq-challenge" type="button" data-challenge>${ICON_VS}<span>${escapeHtml(t.ui.share.challenge)}</span></button>
      </div>
    </div>
  </section>
  <section class="lq-where" aria-labelledby="lq-dist-title">
    <h2 class="lq-section-title" id="lq-dist-title">${escapeHtml(D.title)}</h2>
    <figure class="lq-dist" data-dist></figure>
    <p class="lq-contrib" data-contrib-note role="status"></p>
  </section>
</div>

<div class="lq-r-actions">
  <button class="btn btn--primary btn--lg" type="button" data-retake>${ICON_RETAKE}<span>${escapeHtml(R.retake)}</span></button>
  <a class="btn btn--ghost btn--lg" href="#science">${escapeHtml(R.science_link)}</a>
</div>
<p class="lq-r-disclaimer">${escapeHtml(t.ui.disclaimer)}</p>
</div>`;

  const shareUrl = `${ctx.shareUrl}?r=${code}`;
  const st = t.share_text;
  // Share sheets and most networks put the link after the text, so a line that ends in a colon
  // ("Prove it:") is introducing the link. Its hashtag goes up front instead of in between.
  const withTag = (s) => {
    if (!st.hashtag) return s;
    return /[:：]$/.test(s) ? `#${st.hashtag} ${s}` : `${s} #${st.hashtag}`;
  };
  const challengeText = fill(st.challenge, { lq: r.lq });
  const shareText = () => {
    if (shared) return challengeText;
    if (r.valid) return fill(st.archetype, { archetype: arch.name, lq: r.lq });
    return fill(st.default, { lq: r.lq, pct });
  };
  const shareTitle = fill(st.email_subject, { lq: r.lq });

  let posterPromise = null;
  const poster = () => {
    if (!posterPromise) {
      posterPromise = renderPoster({ ...r, dims: dimPct }, t, fmt).catch((err) => {
        posterPromise = null;
        throw err;
      });
    }
    return posterPromise;
  };

  view.querySelectorAll('[data-retake]').forEach((b) => b.addEventListener('click', ctx.onRetake));
  view.querySelectorAll('[data-jump]').forEach((b) =>
    b.addEventListener('click', async () => {
      // On a phone the share sheet is the point of the button; elsewhere it jumps to the card.
      if (b.dataset.jump === 'lq-share-title' && coarsePointer() && canNativeShare()) {
        let file;
        try {
          const blob = await poster();
          file = new File([blob], t.ui.share.image_file, { type: blob.type || 'image/png' });
        } catch {
          file = undefined;
        }
        if (await nativeShare({ url: shareUrl, text: withTag(shareText()), title: shareTitle, file })) return;
      }
      const target = document.getElementById(b.dataset.jump);
      if (!target) return;
      (target.closest('.lq-share, .lq-where') || target).scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
      target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    }),
  );
  countUp(view.querySelector('[data-lq-num]'), r.lq, ctx.revealDelay || 0);

  const s = t.ui.share;
  mountShareBar(view.querySelector('[data-sharebar]'), {
    url: shareUrl,
    text: withTag(shareText()),
    title: shareTitle,
    lang,
    image: poster,
    imageName: s.image_file,
    labels: { title: s.title, share: s.share, copy: s.copy, copied: s.copied, download: s.download, more: s.more, targets: s.targets },
  });

  const fig = view.querySelector('[data-poster]');
  poster()
    .then((blob) => {
      const img = new Image();
      img.width = 1080;
      img.height = 1350;
      img.alt = '';
      img.decoding = 'async';
      if (posterUrl) URL.revokeObjectURL(posterUrl);
      posterUrl = URL.createObjectURL(blob);
      img.src = posterUrl;
      fig.replaceChildren(img);
    })
    .catch(() => fig.remove());

  // A friend gets the same link with a dare instead of a summary: the share sheet on a phone,
  // the clipboard elsewhere.
  view.querySelector('[data-challenge]').addEventListener('click', async () => {
    if (coarsePointer() && canNativeShare() && (await nativeShare({ url: shareUrl, text: withTag(challengeText), title: shareTitle }))) return;
    if (await copyText(`${challengeText} ${shareUrl}`)) toast(s.challenge_copied);
  });

  mountDistribution(view.querySelector('[data-dist]'), { t, fmt, r });
  showContribution(view.querySelector('[data-contrib-note]'), t, last, lang);

  document.title = fill(t.templates.document_title, { lq: r.lq, archetype: arch.name });
}

// One line under the chart saying whether this result went into the statistics.
function showContribution(el, t, last, lang) {
  const C = t.ui.contribute;
  const say = (state) => {
    const text = C[state] || C.failed;
    el.dataset.state = state;
    el.innerHTML = `${state === 'added' ? ICON_OK : ICON_OFF}<span>${escapeHtml(text)}${sentenceGap(text)}<a href="/privacy/#lq-test-statistics">${escapeHtml(C.privacy)}</a></span>`;
  };
  let done = false;
  // Only say "sending" if the answer takes a moment; most of the time it's already known.
  const pending = setTimeout(() => {
    if (!done) say('sending');
  }, 250);
  contribute(last, lang).then((state) => {
    done = true;
    clearTimeout(pending);
    if (el.isConnected) say(state);
  });
}
