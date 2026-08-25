/* ═══ Crypto Value Screener PWA — lógica principal ═══ */
'use strict';

// ── Estado ────────────────────────────────────────────────────────────────
const LS = {
  theme: 'crypto_theme',
  lang: 'crypto_lang',
  watchlist: 'crypto_watchlist',
  bookmarks: 'crypto_bookmarks',
  data: 'crypto_imported_data',
};

const FAIR_PF = 25;

// ── Idioma ────────────────────────────────────────────────────────────────
let LANG = 'es';

function t(key) {
  if (typeof I18N === 'undefined') return key;   // por si i18n.js no cargó (caché viejo)
  return (I18N[LANG] && I18N[LANG][key]) || I18N.es[key] || key;
}
function tf(key, vars) {
  let s = t(key);
  for (const k in vars) s = s.replace('{' + k + '}', vars[k]);
  return s;
}
function applyLang(lang) {
  LANG = I18N[lang] ? lang : 'es';
  localStorage.setItem(LS.lang, LANG);
  document.documentElement.lang = LANG;
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.innerHTML = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  const btn = document.getElementById('btnLang');
  if (btn) btn.textContent = LANG === 'es' ? 'EN' : 'ES';
}

let DATA = null;            // dataset activo (bundled o importado)
let filtered = [];          // resultado de filtros actual
let shown = 0;              // cuántos cards se han renderizado
const PAGE = 60;

const state = { filter: 'all', search: '', sector: '', sort: 'mos', qYield: false, qDil: false, qTvl: false };

// ── Utilidades ────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function loadJSON(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch { return fallback; }
}
function saveJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { console.warn(e); }
}

function fmtPrice(v) {
  if (v == null) return '—';
  const opts = v >= 1
    ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
    : { maximumSignificantDigits: 4 };
  return '$' + v.toLocaleString('en-US', opts);
}
function fmtMcap(v) {
  if (!v) return '—';
  if (v >= 1e12) return '$' + (v / 1e12).toFixed(2) + ' T';
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + ' B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + ' M';
  return '$' + (v / 1e3).toFixed(0) + ' K';
}
function fmtRatio(v, d) {
  return v == null ? '—' : v.toFixed(d == null ? 1 : d);
}
function fmtPct(v, d) {
  if (v == null) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(d == null ? 1 : d) + '%';
}
function fmtDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(t('locale'), { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return iso; }
}
function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ── Cálculos (para watchlist manual: mcap y fees en $M) ──────────────────
function manualMetrics(m) {
  const pf = m.fees > 0 ? m.mcap / m.fees : null;
  const mos = pf != null ? (1 - pf / FAIR_PF) * 100 : null;
  const fdvMc = (m.fdv && m.mcap > 0) ? m.fdv / m.mcap : null;
  let stars = 0;
  if (pf != null && pf <= FAIR_PF) stars++;
  if (fdvMc != null && fdvMc <= 1.5) stars++;
  return { pf, mos, fdv_mc: fdvMc, stars, valid: pf != null };
}

// ── Clasificación ─────────────────────────────────────────────────────────
function verdict(p) {
  if (!p.valid || p.mos == null) return { cls: 'b-na', label: t('v_na') };
  if (p.trap) return { cls: 'b-fair', label: t('v_trap') };
  if (p.mos >= 33) return { cls: 'b-strong', label: t('v_strong') };
  if (p.mos >= 0) return { cls: 'b-under', label: t('v_under') };
  if (p.mos >= -25) return { cls: 'b-fair', label: t('v_fair') };
  return { cls: 'b-over', label: t('v_over') };
}
function starsHtml(n) {
  n = n || 0;
  return '<span class="stars"><span class="on">' + '★'.repeat(n) + '</span><span class="off">' + '★'.repeat(4 - n) + '</span></span>';
}
function mosHtml(mos, extraCls) {
  if (mos == null) return '<span class="mos-na">N/A</span>';
  const cls = mos >= 0 ? 'mos-pos' : 'mos-neg';
  return `<span class="${cls} ${extraCls || ''}">${mos >= 0 ? '+' : ''}${mos.toFixed(1)}%</span>`;
}

// ── Carga de datos ────────────────────────────────────────────────────────
function initData() {
  const imported = loadJSON(LS.data, null);
  const bundled = (typeof CRYPTO !== 'undefined') ? CRYPTO : null;
  if (imported && bundled) {
    DATA = new Date(imported.updated) >= new Date(bundled.updated) ? imported : bundled;
  } else {
    DATA = imported || bundled || { updated: null, protocols: [] };
  }
  // v1.2: derivar MoS diluido si el dataset es anterior a la métrica
  for (const p of DATA.protocols) {
    if (p.mos_fdv === undefined && p.fdv && p.fees_ann > 0) {
      p.pf_fdv = p.fdv / p.fees_ann;
      p.mos_fdv = (1 - p.pf_fdv / FAIR_PF) * 100;
    }
  }
  updateHdr();
}

function updateHdr() {
  $('hdrUpdated').textContent = DATA && DATA.updated
    ? `${DATA.protocols.length} ${t('hdr_protocols')} · ${fmtDate(DATA.updated)}`
    : t('hdr_nodata');
}

// ── Filtros y orden ───────────────────────────────────────────────────────
function applyFilters() {
  const q = state.search.trim().toUpperCase();
  filtered = DATA.protocols.filter((p) => {
    if (q && !(p.ticker || '').toUpperCase().includes(q) && !(p.name || '').toUpperCase().includes(q)) return false;
    if (state.sector && p.category !== state.sector) return false;
    // filtros de calidad (combinables con todo lo demás)
    if (state.qYield && !(p.yield != null && p.yield > 0)) return false;
    if (state.qDil && !(p.fdv_mc != null && p.fdv_mc <= 1.1)) return false;
    if (state.qTvl && !(p.mc_tvl != null && p.mc_tvl <= 1)) return false;
    switch (state.filter) {
      case 'strong': return p.valid && p.mos != null && p.mos >= 33 && !p.trap;
      case 'under': return p.valid && p.mos != null && p.mos >= 0;
      case 'over': return p.valid && p.mos != null && p.mos < 0;
      case 'stars4': return (p.stars || 0) === 4;
      case 'trap': return !!p.trap;
      default: return true;
    }
  });

  const dir = { mos: -1, mosfdv: -1, stars: -1, mcap: -1, fees30d: -1, yield: -1, age: -1, pf: 1, fdv_mc: 1, ticker: 1 }[state.sort];
  const key = { mos: 'mos', mosfdv: 'mos_fdv', stars: 'stars', mcap: 'market_cap', fees30d: 'fees30d', yield: 'yield', age: 'age', pf: 'pf', fdv_mc: 'fdv_mc', ticker: 'ticker' }[state.sort];
  filtered.sort((a, b) => {
    let va = a[key], vb = b[key];
    if (key === 'ticker') return (va || '').localeCompare(vb || '');
    if (key === 'yield') { va = va || 0; vb = vb || 0; }
    // nulls al final siempre
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return (va - vb) * dir;
  });

  shown = 0;
  $('stockList').innerHTML = '';
  renderMore();
  $('resultCount').textContent = `${filtered.length} ${filtered.length === 1 ? t('result') : t('results')}`;
}

function renderMore() {
  const list = $('stockList');
  const slice = filtered.slice(shown, shown + PAGE);
  if (shown === 0 && slice.length === 0) {
    list.innerHTML = `<div class="empty-msg"><div class="big">🔍</div>${t('empty_results')}</div>`;
    $('btnMore').style.display = 'none';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const p of slice) {
    const v = verdict(p);
    const card = document.createElement('div');
    card.className = 'stock-card';
    card.innerHTML = `
      <div class="sc-top">
        <span class="sc-ticker">${escHtml(p.ticker)}</span>
        <span class="sc-badge ${v.cls}">${v.label}</span>
      </div>
      <div class="sc-mos">${mosHtml(p.mos)}</div>
      <div class="sc-name">${escHtml(p.name || '')} · ${escHtml(p.category || '')}</div>
      <div class="sc-bottom">
        <span class="sc-prices">P/F <b>${fmtRatio(p.pf)}</b> · FDV/MC <b class="${p.fdv_mc != null && p.fdv_mc > 3 ? 'hi-dil' : ''}">${fmtRatio(p.fdv_mc, 2)}${p.fdv_mc != null && p.fdv_mc > 3 ? ' ⚠' : ''}</b> · ${fmtMcap(p.market_cap)}${p.age != null ? ' · ' + p.age.toFixed(1) + t('age_suffix') : ''}</span>
        ${starsHtml(p.stars)}
      </div>`;
    card.addEventListener('click', () => openDetail(p));
    frag.appendChild(card);
  }
  list.appendChild(frag);
  shown += slice.length;
  $('btnMore').style.display = shown < filtered.length ? 'block' : 'none';
}

// ── Stats + selects ───────────────────────────────────────────────────────
function renderStats() {
  const ps = DATA.protocols;
  const valid = ps.filter((p) => p.valid && p.mos != null);
  const under = valid.filter((p) => p.mos >= 0);
  const strong = under.filter((p) => p.mos >= 33 && !p.trap);
  $('statsRow').innerHTML = `
    <div class="stat"><div class="v">${ps.length}</div><div class="l">${t('st_total')}</div></div>
    <div class="stat"><div class="v">${valid.length}</div><div class="l">${t('st_valid')}</div></div>
    <div class="stat s-green"><div class="v">${under.length}</div><div class="l">${t('st_under')}</div></div>
    <div class="stat s-strong"><div class="v">${strong.length}</div><div class="l">${t('st_strong')}</div></div>`;
}

function renderSectorSelect() {
  const cats = [...new Set(DATA.protocols.map((p) => p.category).filter(Boolean))].sort();
  $('sectorSel').innerHTML = `<option value="">${t('sec_all')}</option>` +
    cats.map((c) => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join('');
}

// ── Detail sheet ──────────────────────────────────────────────────────────
let currentDetail = null;

function openDetail(p) {
  currentDetail = p;
  const v = verdict(p);
  const bookmarks = loadJSON(LS.bookmarks, []);
  const isBm = bookmarks.includes(p.ticker);

  const crit = (ok, label, val) => `
    <div class="dt-crit-row">
      <span>${label}</span>
      <span>${val != null ? `<span style="color:var(--text2);margin-right:8px">${val}</span>` : ''}
      <span class="${ok ? 'crit-ok' : 'crit-no'}">${ok ? '✓' : '✗'}</span></span>
    </div>`;

  const verdictBg = { 'b-strong': 'var(--strong-bg)', 'b-under': 'var(--green-bg)', 'b-fair': 'var(--yellow-bg)', 'b-over': 'var(--red-bg)', 'b-na': 'var(--gray-bg)' }[v.cls];
  const verdictColor = { 'b-strong': 'var(--strong-text)', 'b-under': 'var(--green-text)', 'b-fair': 'var(--yellow-text)', 'b-over': 'var(--red-text)', 'b-na': 'var(--gray-text)' }[v.cls];

  $('sheetBody').innerHTML = `
    <div class="dt-head">
      <div>
        <div class="dt-ticker">${escHtml(p.ticker)}</div>
        <div class="dt-name">${escHtml(p.name || '')}</div>
        <div class="dt-sector">${escHtml(p.category || '')} · ${fmtMcap(p.market_cap)}</div>
      </div>
      <button class="dt-bookmark ${isBm ? 'on' : ''}" id="dtBookmark" title="${t('tt_bookmark')}">
        <svg viewBox="0 0 24 24" fill="${isBm ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
      </button>
    </div>
    <div class="dt-verdict" style="background:${verdictBg};color:${verdictColor}">
      <span class="lbl">${v.label}<br>${t('dt_mos_label')}</span>
      <span class="val">${p.mos != null ? (p.mos >= 0 ? '+' : '') + p.mos.toFixed(1) + '%' : 'N/A'}</span>
    </div>
    <div class="dt-grid">
      <div class="dt-metric"><div class="k">${t('dt_price')}</div><div class="v">${fmtPrice(p.price)}</div></div>
      <div class="dt-metric"><div class="k">P/F</div><div class="v">${fmtRatio(p.pf)}</div></div>
      <div class="dt-metric"><div class="k">${t('dt_mcap')}</div><div class="v">${fmtMcap(p.market_cap)}</div></div>
      <div class="dt-metric"><div class="k">${t('dt_fdv')} · FDV/MC</div><div class="v">${fmtMcap(p.fdv)} · ${fmtRatio(p.fdv_mc, 2)}</div></div>
      <div class="dt-metric"><div class="k">${t('dt_mosfdv')}</div><div class="v">${fmtPct(p.mos_fdv)}</div></div>
      <div class="dt-metric"><div class="k">${t('dt_tvl')} · MC/TVL</div><div class="v">${fmtMcap(p.tvl)} · ${fmtRatio(p.mc_tvl, 2)}</div></div>
      <div class="dt-metric"><div class="k">P/R</div><div class="v">${fmtRatio(p.pr)}</div></div>
      <div class="dt-metric"><div class="k">${t('dt_fees30')}</div><div class="v">${fmtMcap(p.fees30d)}</div></div>
      <div class="dt-metric"><div class="k">${t('dt_feesann')}</div><div class="v">${fmtMcap(p.fees_ann)}</div></div>
      <div class="dt-metric"><div class="k">${t('dt_revann')}</div><div class="v">${fmtMcap(p.rev_ann)}</div></div>
      <div class="dt-metric"><div class="k">${t('dt_yield')}</div><div class="v">${p.yield ? p.yield.toFixed(1) + '%' : '—'}</div></div>
      <div class="dt-metric"><div class="k">${t('dt_g30')}</div><div class="v">${fmtPct(p.g30)}</div></div>
      <div class="dt-metric"><div class="k">${t('dt_age')}</div><div class="v">${p.age != null ? p.age.toFixed(1) + ' ' + t('dt_years') : '—'}</div></div>
      <div class="dt-metric"><div class="k">${t('dt_ath')}</div><div class="v">${fmtPct(p.ath_down)}</div></div>
      <div class="dt-metric"><div class="k">${t('dt_audits')}</div><div class="v">${p.audits || '—'}</div></div>
    </div>
    ${p.trap ? `<div class="warn-box">${t('warn_trap')}</div>` : ''}
    ${!p.trap && p.pf != null && p.pf < 3 ? `<div class="warn-box">${t('warn_lowpf')}</div>` : ''}
    <div class="dt-crit">
      <div class="card-title">${t('dt_crit_title')} ${starsHtml(p.stars)}</div>
      ${crit(p.pf != null && p.pf <= FAIR_PF, t('dt_c1'), fmtRatio(p.pf))}
      ${crit(p.fdv_mc != null && p.fdv_mc <= 1.5, t('dt_c2'), fmtRatio(p.fdv_mc, 2))}
      ${crit(p.g30 != null && p.g30 > 0, t('dt_c3'), fmtPct(p.g30))}
      ${crit(p.age != null && p.age >= 2, t('dt_c4'), p.age != null ? p.age.toFixed(1) + ' ' + t('dt_years') : '—')}
    </div>
    <div class="dt-links">
      ${p.gecko ? `<a class="dt-link" href="https://www.coingecko.com/en/coins/${encodeURIComponent(p.gecko)}" target="_blank" rel="noopener">${t('dt_gecko')}</a>` : ''}
      <a class="dt-link" href="https://defillama.com/fees" target="_blank" rel="noopener">${t('dt_llama')}</a>
    </div>`;

  $('dtBookmark').addEventListener('click', toggleBookmark);
  $('sheet').classList.add('open');
  $('sheetBackdrop').classList.add('open');
}

function closeDetail() {
  $('sheet').classList.remove('open');
  $('sheetBackdrop').classList.remove('open');
}

function toggleBookmark() {
  if (!currentDetail) return;
  let bookmarks = loadJSON(LS.bookmarks, []);
  const tk = currentDetail.ticker;
  if (bookmarks.includes(tk)) {
    bookmarks = bookmarks.filter((x) => x !== tk);
    toast(tf('toast_bm_del', { tk }));
  } else {
    bookmarks.push(tk);
    toast(tf('toast_bm_add', { tk }));
  }
  saveJSON(LS.bookmarks, bookmarks);
  const btn = $('dtBookmark');
  const on = bookmarks.includes(tk);
  btn.classList.toggle('on', on);
  btn.querySelector('svg').setAttribute('fill', on ? 'currentColor' : 'none');
  renderWatchlist();
}

// ── Watchlist ─────────────────────────────────────────────────────────────
function renderWatchlist() {
  const manual = loadJSON(LS.watchlist, []);
  const bookmarks = loadJSON(LS.bookmarks, []);
  const bmProtocols = bookmarks
    .map((tk) => DATA.protocols.find((p) => p.ticker === tk))
    .filter(Boolean);

  const total = manual.length + bmProtocols.length;
  $('wlCount').textContent = total ? `${total} ${total === 1 ? t('wl_n_one') : t('wl_n_many')}` : '';

  if (!total) {
    $('wlBody').innerHTML = `<div class="empty-msg"><div class="big">📋</div>${t('wl_empty')}</div>`;
    return;
  }

  const rows = [];
  for (const p of bmProtocols) {
    rows.push(wlRow(p, 'screener', null));
  }
  manual.forEach((m, i) => {
    const met = manualMetrics(m);
    rows.push(wlRow({ ...m, ...met }, 'manual', i));
  });
  $('wlBody').innerHTML = rows.join('');

  // listeners
  $('wlBody').querySelectorAll('[data-wl-open]').forEach((el) => {
    el.addEventListener('click', () => {
      const tk = el.getAttribute('data-wl-open');
      const p = DATA.protocols.find((x) => x.ticker === tk);
      if (p) openDetail(p);
    });
  });
  $('wlBody').querySelectorAll('[data-wl-del]').forEach((el) => {
    el.addEventListener('click', () => {
      const [src, idx] = el.getAttribute('data-wl-del').split(':');
      if (src === 'manual') {
        const list = loadJSON(LS.watchlist, []);
        const removed = list.splice(Number(idx), 1);
        saveJSON(LS.watchlist, list);
        toast(tf('toast_removed', { tk: removed[0]?.ticker || '' }));
      } else {
        let bms = loadJSON(LS.bookmarks, []);
        bms = bms.filter((x) => x !== idx);
        saveJSON(LS.bookmarks, bms);
        toast(tf('toast_removed', { tk: idx }));
      }
      renderWatchlist();
    });
  });
}

function wlRow(p, src, idx) {
  const openAttr = src === 'screener' ? `data-wl-open="${escHtml(p.ticker)}"` : '';
  return `
    <div class="wl-item">
      <div class="wl-main" ${openAttr}>
        <div class="wl-tk">${escHtml(p.ticker)} ${starsHtml(p.stars)}</div>
        <div class="wl-nm">${escHtml(p.name || '')}</div>
        <div class="wl-src">${src === 'manual' ? t('wl_manual') : t('wl_screener')}</div>
      </div>
      <div class="wl-metrics">
        <div class="wl-mos">${mosHtml(p.mos)}</div>
        <div class="wl-gn">P/F ${fmtRatio(p.pf)} · FDV/MC ${fmtRatio(p.fdv_mc, 2)}</div>
      </div>
      <button class="wl-del" data-wl-del="${src === 'manual' ? 'manual:' + idx : 'bm:' + escHtml(p.ticker)}" aria-label="Eliminar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
    </div>`;
}

function addManualProtocol() {
  const tk = $('fTk').value.trim().toUpperCase();
  const mcap = parseFloat($('fMc').value);
  const fees = parseFloat($('fFe').value);
  const fdv = parseFloat($('fFd').value);
  const name = $('fNm').value.trim();

  if (!tk) { toast(t('toast_ticker_req')); return; }
  if (!mcap || mcap <= 0) { toast(t('toast_mcap_bad')); return; }
  if (isNaN(fees) || fees <= 0) { toast(t('toast_fees_req')); return; }

  const list = loadJSON(LS.watchlist, []);
  if (list.some((x) => x.ticker === tk)) { toast(tf('toast_dupe', { tk })); return; }
  list.push({ ticker: tk, name: name || tk, mcap, fees, fdv: isNaN(fdv) ? null : fdv, added: new Date().toISOString() });
  saveJSON(LS.watchlist, list);

  ['fTk', 'fMc', 'fFe', 'fFd', 'fNm'].forEach((id) => { $(id).value = ''; });
  toast(tf('toast_added', { tk }));
  renderWatchlist();
}

// ── Mercado: Fear & Greed + global + categorías + tops ────────────────────
function fngZone(v) {
  // contrarian: miedo extremo = zona verde para un inversor de valor
  if (v < 25) return { label: t('fng_z1'), bg: 'var(--green-bg)', color: 'var(--green-text)' };
  if (v < 45) return { label: t('fng_z2'), bg: 'var(--green-bg)', color: 'var(--green-text)' };
  if (v < 55) return { label: t('fng_z3'), bg: 'var(--yellow-bg)', color: 'var(--yellow-text)' };
  if (v < 75) return { label: t('fng_z4'), bg: 'var(--orange-bg)', color: 'var(--orange-text)' };
  return { label: t('fng_z5'), bg: 'var(--red-bg)', color: 'var(--red-text)' };
}

function renderFNG() {
  const fng = DATA.fng || {};
  const v = fng.value;
  const pct = v != null ? Math.min(v / 100, 1) : 0;
  const angle = -110 + pct * 220;
  const zone = v != null ? fngZone(v) : null;

  // gauge SVG: arco de -110° a +110°
  const polar = (deg, r) => {
    const rad = (deg - 90) * Math.PI / 180;
    return [60 + r * Math.cos(rad), 60 + r * Math.sin(rad)];
  };
  const arc = (from, to, r) => {
    const [x1, y1] = polar(from, r);
    const [x2, y2] = polar(to, r);
    return `M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  };
  const seg = (a, b, color) => `<path d="${arc(-110 + a * 220, -110 + b * 220, 46)}" stroke="${color}" stroke-width="11" fill="none" stroke-linecap="round" opacity=".85"/>`;
  const [nx, ny] = polar(angle, 34);

  $('fngGauge').innerHTML = `
    <svg width="130" height="105" viewBox="0 0 120 95">
      ${seg(0, 0.25, '#059669')}
      ${seg(0.25, 0.55, '#d97706')}
      ${seg(0.55, 0.75, '#ea580c')}
      ${seg(0.75, 1, '#dc2626')}
      ${v != null ? `<line x1="60" y1="60" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" stroke="var(--text)" stroke-width="3" stroke-linecap="round"/>
      <circle cx="60" cy="60" r="5" fill="var(--text)"/>` : ''}
    </svg>`;

  if (v != null) {
    $('fngNum').textContent = v;
    $('fngPill').textContent = zone.label;
    $('fngPill').style.background = zone.bg;
    $('fngPill').style.color = zone.color;
    $('fngDate').textContent = fng.date ? tf('fng_updated', { date: fmtDate(fng.date) }) : '';
  } else {
    $('fngNum').textContent = '—';
    $('fngPill').textContent = t('fng_nodata');
    $('fngPill').style.background = '';
    $('fngPill').style.color = '';
    $('fngDate').textContent = '';
  }
}

// ── Gráficas SVG (sin librerías) ─────────────────────────────────────────
// series: [[etiqueta, valor], ...] — dibuja línea + área con min/max/fechas
function lineChart(series, fmtVal) {
  const W = 320, H = 100, PL = 6, PR = 6, PT = 16, PB = 16;
  const vals = series.map((p) => p[1]);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = (max - min) || 1;
  const x = (i) => PL + i * (W - PL - PR) / (series.length - 1);
  const y = (v) => PT + (1 - (v - min) / span) * (H - PT - PB);
  const pts = series.map((p, i) => `${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ');
  const li = series.length - 1;
  const fmtD = (d) => {
    try { return new Date(d + 'T00:00:00Z').toLocaleDateString(t('locale'), { month: 'short', year: '2-digit', timeZone: 'UTC' }); }
    catch { return d; }
  };
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" preserveAspectRatio="none">
    <polygon points="${PL},${H - PB} ${pts} ${(W - PR)},${H - PB}" fill="var(--accent-soft)" opacity=".5"/>
    <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(li).toFixed(1)}" cy="${y(series[li][1]).toFixed(1)}" r="3" fill="var(--accent)"/>
    <text x="${PL}" y="10" class="ch-lbl">${t('ch_max')} ${fmtVal(max)} · ${t('ch_min')} ${fmtVal(min)}</text>
    <text x="${PL}" y="${H - 4}" class="ch-lbl">${fmtD(series[0][0])}</text>
    <text x="${W - PR}" y="${H - 4}" text-anchor="end" class="ch-lbl">${fmtD(series[li][0])}</text>
  </svg>`;
}

function renderHistCharts() {
  // P/F mediano histórico — se acumula una entrada por corrida diaria
  const hist = (DATA.history || []).filter((h) => h.pf != null).map((h) => [h.d, h.pf]);
  if (hist.length >= 2) {
    $('histChart').innerHTML = lineChart(hist, (v) => v.toFixed(1));
    $('histLast').textContent = `${t('ch_today')}: ${hist[hist.length - 1][1].toFixed(1)}`;
  } else {
    const cur = DATA.med_pf != null ? DATA.med_pf.toFixed(1) : '—';
    $('histChart').innerHTML = `<div class="ch-building"><span class="ch-big">${cur}</span>${t('hist_building')}</div>`;
    $('histLast').textContent = '';
  }

  // fees anualizados de todo el mercado (backfill 1 año de DefiLlama)
  const mf = DATA.market_fees || [];
  if (mf.length >= 2) {
    $('feesChart').innerHTML = lineChart(mf, (v) => fmtMcap(v));
    $('feesLast').textContent = `${t('ch_today')}: ${fmtMcap(mf[mf.length - 1][1])}`;
  } else {
    $('feesChart').innerHTML = `<div class="empty-msg">${t('fng_nodata')}</div>`;
    $('feesLast').textContent = '';
  }
}

function renderMarket() {
  renderFNG();
  renderHistCharts();

  // stats globales + P/F mediano del universo (lectura de régimen: si TODO
  // está barato, el MoS individual vale como ranking, no como señal absoluta)
  const g = DATA.global || {};
  const pfs = DATA.protocols.map((p) => p.pf).filter((v) => v != null).sort((a, b) => a - b);
  const medPf = DATA.med_pf != null ? DATA.med_pf : (pfs.length ? pfs[Math.floor(pfs.length / 2)] : null);
  $('globalStats').innerHTML = `
    <div class="stat"><div class="v">${g.mcap ? fmtMcap(g.mcap) : '—'}</div><div class="l">${t('gl_mcap')}</div></div>
    <div class="stat"><div class="v">${g.btc_dom != null ? g.btc_dom + '%' : '—'}</div><div class="l">${t('gl_btc')}</div></div>
    <div class="stat"><div class="v">${g.eth_dom != null ? g.eth_dom + '%' : '—'}</div><div class="l">${t('gl_eth')}</div></div>
    <div class="stat"><div class="v">${medPf != null ? medPf.toFixed(1) : '—'}</div><div class="l">${t('gl_pf')}</div></div>`;

  // categorías con oportunidades (MoS >= 0, sin trampas)
  const byCat = {};
  for (const p of DATA.protocols) {
    if (!p.valid || p.mos == null || p.mos < 0 || p.trap) continue;
    const c = p.category || t('sec_others');
    byCat[c] = (byCat[c] || 0) + 1;
  }
  const entries = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const maxN = entries[0]?.[1] || 1;
  $('sectorBars').innerHTML = entries.length
    ? entries.map(([c, n]) => `
      <div class="sbar">
        <div class="sbar-head"><span class="sbar-name">${escHtml(c)}</span><span class="sbar-n">${n}</span></div>
        <div class="sbar-track"><div class="sbar-fill" style="width:${(n / maxN * 100).toFixed(0)}%"></div></div>
      </div>`).join('')
    : `<div class="empty-msg">${t('sec_empty')}</div>`;

  // top 10 por MoS diluido (v1.2: rankear sobre FDV castiga la dilución
  // pendiente; sin trampas)
  const rankMos = (p) => p.mos_fdv != null ? p.mos_fdv : p.mos;
  const top = DATA.protocols
    .filter((p) => p.valid && rankMos(p) != null && !p.trap)
    .sort((a, b) => rankMos(b) - rankMos(a))
    .slice(0, 10);
  $('topList').innerHTML = topListHtml(top, (p) => fmtPct(rankMos(p)));
  bindTopList('topList');

  // top 10 por real yield (sin trampas)
  const topYield = DATA.protocols
    .filter((p) => p.yield != null && p.yield > 0 && !p.trap)
    .sort((a, b) => b.yield - a.yield)
    .slice(0, 10);
  $('yieldList').innerHTML = topYield.length
    ? topListHtml(topYield, (p) => p.yield.toFixed(1) + '%')
    : `<div class="empty-msg">${t('sec_empty')}</div>`;
  bindTopList('yieldList');
}

function topListHtml(list, valFn) {
  return list.map((p, i) => `
    <div class="top-item" data-tk="${escHtml(p.ticker)}">
      <div class="top-rank">${i + 1}</div>
      <div class="top-main">
        <div class="top-tk">${escHtml(p.ticker)} ${starsHtml(p.stars)}</div>
        <div class="top-nm">${escHtml(p.name || '')} · ${escHtml(p.category || '')}</div>
      </div>
      <div class="top-mos">${valFn(p)}</div>
    </div>`).join('');
}
function bindTopList(id) {
  $(id).querySelectorAll('.top-item').forEach((el) => {
    el.addEventListener('click', () => {
      const p = DATA.protocols.find((x) => x.ticker === el.getAttribute('data-tk'));
      if (p) openDetail(p);
    });
  });
}

// ── Actualización de datos ────────────────────────────────────────────────
// Acepta crypto_screen.json (JSON puro) o data.js (var CRYPTO={...};)
function parseScreenerText(text) {
  const braceStart = text.indexOf('{');
  const braceEnd = text.lastIndexOf('}');
  if (braceStart === -1 || braceEnd === -1) throw new Error('Formato no reconocido');
  const obj = JSON.parse(text.slice(braceStart, braceEnd + 1));
  if (!Array.isArray(obj.protocols) || !obj.updated) throw new Error('El archivo no contiene datos del screener');
  return obj;
}

function adoptData(obj, toastKey) {
  saveJSON(LS.data, obj);
  initData();
  renderAll();
  toast(tf(toastKey, { n: obj.protocols.length, date: fmtDate(obj.updated) }));
}

function handleImportFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      adoptData(parseScreenerText(String(reader.result)), 'toast_data_imported');
    } catch (e) {
      console.error(e);
      toast(t('toast_import_err'));
    }
  };
  reader.readAsText(file);
}

// Descarga data.js del mismo sitio (publicado por GitHub Actions) saltando el caché
let refreshing = false;
async function refreshData(silent) {
  if (refreshing) return;
  refreshing = true;
  if (!silent) toast(t('toast_searching'));
  try {
    const resp = await fetch('data.js?t=' + Date.now(), { cache: 'no-store' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const obj = parseScreenerText(await resp.text());
    const current = DATA?.updated ? new Date(DATA.updated) : 0;
    if (new Date(obj.updated) <= current) {
      if (!silent) toast(t('toast_latest'));
    } else {
      adoptData(obj, 'toast_data_updated');
    }
  } catch (e) {
    console.warn('refreshData:', e);
    if (!silent) toast(t('toast_refresh_err'));
  } finally {
    refreshing = false;
  }
}

// ── Tema ──────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  $('iconMoon').style.display = theme === 'dark' ? 'none' : 'block';
  $('iconSun').style.display = theme === 'dark' ? 'block' : 'none';
  localStorage.setItem(LS.theme, theme);
}

// ── Navegación ────────────────────────────────────────────────────────────
function switchView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
  $('view-' + name).classList.add('active');
  document.querySelector(`.nav-item[data-view="${name}"]`).classList.add('active');
  window.scrollTo({ top: 0 });
  if (name === 'market') renderMarket();
  if (name === 'watchlist') renderWatchlist();
}

// ── Render global ─────────────────────────────────────────────────────────
function renderAll() {
  renderStats();
  renderSectorSelect();
  applyFilters();
  renderWatchlist();
  renderMarket();
}

// ── Init ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // tema
  const savedTheme = localStorage.getItem(LS.theme)
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(savedTheme);
  $('btnTheme').addEventListener('click', () =>
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));

  // idioma: guardado, o el del teléfono
  const savedLang = localStorage.getItem(LS.lang)
    || ((navigator.language || 'es').toLowerCase().startsWith('es') ? 'es' : 'en');
  applyLang(savedLang);
  $('btnLang').addEventListener('click', () => {
    applyLang(LANG === 'es' ? 'en' : 'es');
    updateHdr();
    renderAll();
  });

  initData();
  renderAll();

  // navegación
  document.querySelectorAll('.nav-item').forEach((btn) =>
    btn.addEventListener('click', () => switchView(btn.dataset.view)));

  // filtros
  $('filterChips').querySelectorAll('.chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      $('filterChips').querySelector('.chip.active').classList.remove('active');
      chip.classList.add('active');
      state.filter = chip.dataset.filter;
      applyFilters();
    }));
  $('qualityChips').querySelectorAll('.chip-q').forEach((chip) =>
    chip.addEventListener('click', () => {
      chip.classList.toggle('active');
      if (chip.dataset.q === 'yield') state.qYield = chip.classList.contains('active');
      if (chip.dataset.q === 'dilution') state.qDil = chip.classList.contains('active');
      if (chip.dataset.q === 'tvl') state.qTvl = chip.classList.contains('active');
      applyFilters();
    }));
  let searchTimer = null;
  $('searchBox').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.search = e.target.value; applyFilters(); }, 200);
  });
  $('sectorSel').addEventListener('change', (e) => { state.sector = e.target.value; applyFilters(); });
  $('sortSel').addEventListener('change', (e) => { state.sort = e.target.value; applyFilters(); });
  $('btnMore').addEventListener('click', renderMore);

  // watchlist
  $('btnAdd').addEventListener('click', addManualProtocol);

  // sheet
  $('sheetBackdrop').addEventListener('click', closeDetail);
  $('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) closeDetail(); });

  // importar / actualizar
  $('btnImport').addEventListener('click', () => $('fileImport').click());
  $('fileImport').addEventListener('change', (e) => {
    if (e.target.files?.[0]) handleImportFile(e.target.files[0]);
    e.target.value = '';
  });
  $('btnRefresh').addEventListener('click', () => refreshData(false));
  // al abrir con internet, busca datos nuevos en silencio
  if (navigator.onLine) setTimeout(() => refreshData(true), 1500);

  // service worker — con auto-recarga cuando llega una versión nueva de la app
  if ('serviceWorker' in navigator) {
    if (navigator.serviceWorker.controller) {
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded) return;
        reloaded = true;
        location.reload();
      });
    }
    navigator.serviceWorker.register('sw.js')
      .then((reg) => reg.update())
      .catch(() => {});
  }
});
