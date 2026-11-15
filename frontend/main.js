// main.js - UI orchestration: start screen, API, HUD, panels, game-over.
import { Game, initPhysics } from './game.js';
import { MAPPINGS, computePhysics } from './mapping.js';
import { selectDependencies, orderDependencies, buildLayout } from './tower.js';
import { KIND_COLORS, KIND_LABELS, ECO_COLORS, PLAYER_COLORS, colorFor } from './theme.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

const S = {
  payload: null,
  limit: Number(store.get('dj.limit', 54)) || 54,
  players: [store.get('dj.p1', 'Player 1'), store.get('dj.p2', 'Player 2')],
  current: 0,
  turn: 1,
  removed: [],
  layout: null,
  game: null,
  abort: null,
};

// ------------------------------------------------------------------ legends
function mappingLegendHTML() {
  return MAPPINGS.filter((m) => m.enabled)
    .map((m) => `<div class="m"><b>${esc(m.label)} <span class="arrow">&rarr;</span> ${esc(m.target)}</b><span>${esc(m.legend)}</span></div>`)
    .join('');
}
function kindLegendHTML() {
  const items = Object.entries(KIND_COLORS).map(([k, c]) => `<div class="k"><i style="background:${c}"></i>${esc(KIND_LABELS[k])}</div>`);
  const eco = Object.entries(ECO_COLORS).slice(0, 4).map(([k, c]) => `<div class="k"><i style="background:${c}"></i>pkg: ${esc(k)}</div>`);
  return items.concat(eco).join('');
}
$('mapping-legend').innerHTML = mappingLegendHTML();
$('mapping-legend-hud').innerHTML = mappingLegendHTML();
$('kind-legend').innerHTML = kindLegendHTML();

// ------------------------------------------------------------------ misc UI
let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

function bindSeg(id) {
  const seg = $(id);
  const paint = () => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', Number(b.dataset.n) === S.limit));
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    S.limit = Number(b.dataset.n);
    store.set('dj.limit', S.limit);
    document.querySelectorAll('.seg').forEach((s) => s.querySelectorAll('button').forEach((x) => x.classList.toggle('on', Number(x.dataset.n) === S.limit)));
    if (id === 'limit-seg' && S.payload) startGame(S.payload);
  });
  paint();
}
bindSeg('start-limit-seg');
bindSeg('limit-seg');

function renderPlayers() {
  const box = $('players');
  if (!box.children.length) {
    box.innerHTML = [0, 1].map((i) => `<div class="player" data-i="${i}" style="--pc:${PLAYER_COLORS[i]}">
      <span class="dot"></span><input maxlength="16" value="${esc(S.players[i])}" aria-label="Player ${i + 1} name"><span class="badge">your turn</span></div>`).join('');
    box.querySelectorAll('.player').forEach((el) => {
      const i = Number(el.dataset.i);
      el.querySelector('input').addEventListener('input', (e) => {
        S.players[i] = e.target.value.trim() || `Player ${i + 1}`;
        store.set(i ? 'dj.p2' : 'dj.p1', e.target.value);
      });
    });
  }
  box.querySelectorAll('.player').forEach((el) => el.classList.toggle('active', Number(el.dataset.i) === S.current));
  $('turn-no').textContent = S.turn;
}

// ------------------------------------------------------------------ screens
function show(which) {
  $('start').hidden = which !== 'start';
  $('loading').hidden = which !== 'loading';
  $('hud').hidden = which !== 'hud';
  if (which !== 'hud') $('gameover').hidden = true;
}
function showError(msg) {
  const e = $('start-error');
  e.textContent = msg;
  e.hidden = !msg;
}

// ------------------------------------------------------------------ data loading
const LOADING_MSGS = [
  'Cloning the repo...', 'Reading manifests and lockfiles...', 'Asking registries who depends on whom...',
  'Counting recent commits...', 'Weighing bundles...', 'Looking for that one project in Nebraska...',
  'Almost done stacking...',
];
let loadTimer = 0;
function startLoadingUI() {
  show('loading');
  const t0 = Date.now();
  let i = 0;
  $('loading-msg').textContent = LOADING_MSGS[0];
  $('loading-time').textContent = '0s';
  clearInterval(loadTimer);
  loadTimer = setInterval(() => {
    const s = Math.round((Date.now() - t0) / 1000);
    $('loading-time').textContent = `${s}s`;
    if (s > 0 && s % 4 === 0) { i = (i + 1) % LOADING_MSGS.length; $('loading-msg').textContent = LOADING_MSGS[i]; }
  }, 1000);
}
function stopLoadingUI() { clearInterval(loadTimer); }

async function analyze(url) {
  showError('');
  S.abort = new AbortController();
  startLoadingUI();
  const timeout = setTimeout(() => S.abort.abort('timeout'), 180000);
  try {
    const res = await fetch('/api/analyze?url=' + encodeURIComponent(url), { signal: S.abort.signal });
    let data = null;
    try { data = await res.json(); } catch { /* non-json body */ }
    if (!res.ok) throw new Error((data && (typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail))) || `Server returned ${res.status}`);
    if (!data || !Array.isArray(data.dependencies)) throw new Error('Unexpected response from the server.');
    if (!data.dependencies.length) throw new Error('No dependencies were found in that repository.');
    stopLoadingUI();
    await startGame(data);
  } catch (err) {
    stopLoadingUI();
    show('start');
    if (S.abort?.signal.aborted && S.abort.signal.reason !== 'timeout') return;
    showError(S.abort?.signal.reason === 'timeout' ? 'The analysis took too long. Try a smaller repo.' : `Could not analyze: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function loadDemo() {
  showError('');
  try {
    const res = await fetch('sample.json');
    if (!res.ok) throw new Error(`sample.json: ${res.status}`);
    await startGame(await res.json());
  } catch (err) {
    showError(`Could not load demo: ${err.message}`);
  }
}

// ------------------------------------------------------------------ game
async function ensureGame() {
  if (S.game) return S.game;
  await initPhysics();
  S.game = new Game($('view'), {
    onHover: onHover, onSelect: renderInfo, onHint: toast, onRemoved, onTurnEnd, onGameOver, onPullState,
  });
  window.__game = S.game; // debugging / tests
  return S.game;
}

async function startGame(payload) {
  S.payload = payload;
  try { await document.fonts.load('40px "Patrick Hand"'); } catch { /* font optional */ }
  const game = await ensureGame();
  const chosen = selectDependencies(payload.dependencies, S.limit);
  const phys = computePhysics(chosen);
  const items = orderDependencies(chosen.map((dep, i) => ({ dep, phys: phys[i] })));
  S.layout = buildLayout(items);
  S.items = items;
  $('repo-name').textContent = payload.repo?.name || 'repository';
  $('repo-meta').textContent = `${chosen.length} of ${payload.dependencies.length} dependencies as blocks` + (payload.repo?.commit ? ` @ ${String(payload.repo.commit).slice(0, 7)}` : '');
  const w = payload.warnings || [];
  $('warnings').hidden = !w.length;
  $('warn-count').textContent = `${w.length} warning${w.length === 1 ? '' : 's'}`;
  $('warn-list').innerHTML = w.map((x) => `<li>${esc(x)}</li>`).join('');
  document.querySelectorAll('.seg').forEach((s) => s.querySelectorAll('button').forEach((x) => x.classList.toggle('on', Number(x.dataset.n) === S.limit)));
  show('hud');
  document.querySelector('.legend-box').open = window.innerWidth > 820;
  resetRound();
  game.resize();
}

function resetRound() {
  S.current = 0;
  S.turn = 1;
  S.removed = [];
  $('removed').hidden = true;
  $('removed-list').innerHTML = '';
  $('gameover').hidden = true;
  $('info').hidden = true;
  let rep = S.game.loadTower(S.layout, 0);
  if (!rep.stable && S.layout.mode === 'depth' && !S.layout.merged) {
    console.warn('[jenga] tower did not settle cleanly, merging singleton levels', rep);
    S.layout = buildLayout(S.items, { mergeSingletons: true });
    S.layout.merged = true;
    rep = S.game.loadTower(S.layout, 0);
  }
  $('blocks-left').textContent = S.game.blocks.length;
  renderPlayers();
  $('hintbar').textContent = `${S.players[0]}: drag a block along its length to pull it out. Drag empty space to orbit, wheel to zoom.`;
  console.info('[jenga] tower settled', S.game.settleReport, `layers=${S.layout.layers.length} mode=${S.layout.mode}`);
}

function onPullState(on) {
  $('hintbar').textContent = on ? 'Pull it all the way out. Let go to stop.' : $('hintbar').textContent;
}
function onRemoved(b) {
  S.removed.push({ b, by: S.current });
  $('removed').hidden = false;
  $('removed-list').insertAdjacentHTML('beforeend',
    `<span class="rc" style="color:${PLAYER_COLORS[S.current]}"><i style="background:${b.color}"></i><span style="color:var(--ink)">${esc(b.dep.name)}</span></span>`);
  $('blocks-left').textContent = S.game.blocks.filter((x) => !x.removed).length;
  $('hintbar').textContent = 'Nice. Waiting for the tower to settle...';
}
function onTurnEnd() {
  S.current = 1 - S.current;
  S.turn++;
  S.game.setPlayer(S.current);
  renderPlayers();
  $('hintbar').textContent = `${S.players[S.current]}'s turn. Pick a block you think is safe.`;
}
function onGameOver({ fallen, culprit, draw }) {
  if (draw) {
    $('over-card').classList.add('draw');
    $('over-crash').textContent = 'DRAW';
    $('over-title').innerHTML = 'Nobody broke it &mdash; this repo is too well-behaved.';
    $('over-detail').innerHTML = 'No block can be pulled any more, so the tower stands. Stability is a dependency too.';
    setTimeout(() => { if (S.game.state === 'over') $('gameover').hidden = false; }, 900);
    return;
  }
  $('over-card').classList.remove('draw');
  $('over-crash').textContent = 'CRASH';
  const loser = S.players[S.current];
  const c = culprit.dep;
  $('over-title').innerHTML = `<b style="color:${PLAYER_COLORS[S.current]}">${esc(loser)}</b> pulled <code>${esc(c.name)}</code> and broke the internet.`;
  const upstream = fallen && fallen !== culprit ? ` ${esc(fallen.dep.name)} was the first to fall.` : '';
  $('over-detail').innerHTML = `${esc(KIND_LABELS[c.kind] || c.kind)}${c.version ? ' ' + esc(c.version) : ''}, turn ${S.turn}.${upstream}<br>${S.players[1 - S.current] ? esc(S.players[1 - S.current]) + ' wins.' : ''}`;
  setTimeout(() => { if (S.game.state === 'over') $('gameover').hidden = false; }, 1600);
}

// ------------------------------------------------------------------ info panel / tooltip
const fmtNum = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 1 }));
function fmtBytes(v) {
  if (v == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0; let x = v;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(x < 10 && i ? 1 : 0)} ${u[i]}`;
}
const fmtAge = (d) => (d == null ? '—' : d >= 365 ? `${(d / 365).toFixed(1)} yrs` : `${d} days`);
const fmtDate = (s) => (s ? String(s).slice(0, 10) : '—');

function onHover(b, x, y) {
  const tip = $('tooltip');
  if (!b) { tip.hidden = true; return; }
  tip.innerHTML = `<b>${esc(b.dep.name)}</b><small>${esc(b.dep.kind)} - mass ${b.mass.toFixed(1)}, friction ${b.phys.friction?.value.toFixed(2)}</small>`;
  tip.hidden = false;
  const w = tip.offsetWidth;
  tip.style.left = Math.min(window.innerWidth - w - 8, x + 16) + 'px';
  tip.style.top = y + 16 + 'px';
}

function depLists(d) {
  const items = S.items || [];
  const ids = new Set(items.map((it) => it.dep.id));
  const needs = (d.depends_on || []).filter((x) => ids.has(x));
  const users = items.filter((it) => (it.dep.depends_on || []).includes(d.id));
  const nm = (id) => esc(items.find((it) => it.dep.id === id)?.dep.name ?? id);
  const list = (label, arr) => (arr.length
    ? `<div class="desc"><b>${label}</b> ${arr.slice(0, 12).join(', ')}${arr.length > 12 ? ` +${arr.length - 12} more` : ''}</div>` : '');
  return list('Rests on:', needs.map(nm)) + list('Carries:', users.map((it) => esc(it.dep.name)));
}

function renderInfo(b) {
  const el = $('info');
  if (!b) { el.hidden = true; return; }
  const d = b.dep, m = d.metrics || {}, ph = b.phys;
  const row = (k, v) => `<tr><td>${k}</td><td>${v}</td></tr>`;
  const commitsLabel = m.recent_commits_source === 'releases' ? 'Releases / year' : 'Commits (90d)';
  const physRow = (label, val, p, mapId) => {
    const mp = MAPPINGS.find((x) => x.id === mapId);
    return `<div class="phys"><div class="top"><span>${label}</span><b>${val}</b></div>
      <div class="bar"><i style="width:${Math.round((p?.t ?? 0) * 100)}%"></i></div>
      <small>${mp ? esc(mp.label) : ''}${p?.missing ? ' (no data, default used)' : ''}</small></div>`;
  };
  const extra = MAPPINGS.filter((mp) => mp.enabled && !['width', 'density', 'friction'].includes(mp.prop))
    .map((mp) => physRow(esc(mp.target), ph[mp.prop].value.toFixed(2), ph[mp.prop], mp.id)).join('');
  el.className = 'card right info';
  el.innerHTML = `
    <h3>${esc(d.name)}</h3><div class="ver">${esc(d.version || '')}</div>
    <div class="chips"><span class="chip" style="background:${b.color}">${esc(KIND_LABELS[d.kind] || d.kind)}</span>
      <span class="chip">${esc(d.ecosystem || '?')}</span><span class="chip">${d.direct ? 'direct' : 'transitive'}</span>
      <span class="chip">layer ${b.layer + 1}</span>${b.level != null ? `<span class="chip">depth ${b.level}</span>` : ''}</div>
    ${depLists(d)}
    ${d.description ? `<div class="desc">${esc(d.description)}</div>` : ''}
    <div class="sec">Metrics</div>
    <table>
      ${row('Bundle size', fmtBytes(m.size_bytes))}
      ${row('Imports here', fmtNum(m.import_count))}
      ${row('Dependents in tree', fmtNum(m.dependents_in_tree))}
      ${row('Global dependents', fmtNum(m.global_dependents))}
      ${row(commitsLabel, fmtNum(m.recent_commits))}
      ${row('Open issues / PRs', `${fmtNum(m.open_issues)} / ${fmtNum(m.open_prs)}`)}
      ${row('Stars', fmtNum(m.stars))}
      ${row('Age', fmtAge(m.age_days))}
      ${row('First / last release', `${fmtDate(m.first_release)} / ${fmtDate(m.last_release)}`)}
      ${d.source_file ? row('Declared in', esc(d.source_file)) : ''}
    </table>
    <div class="sec">Derived physics</div>
    ${physRow('Width', b.w.toFixed(2) + ' u', ph.width, 'size')}
    ${physRow('Mass', b.mass.toFixed(1), ph.density, 'uses')}
    ${physRow('Friction', ph.friction.value.toFixed(2), ph.friction, 'commits')}
    ${extra}
    ${d.repo_url ? `<div class="desc"><a href="${esc(d.repo_url)}" target="_blank" rel="noopener noreferrer">${esc(d.repo_url.replace(/^https?:\/\//, ''))}</a></div>` : ''}
  `;
  el.hidden = false;
}

// ------------------------------------------------------------------ wiring
$('analyze-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = $('repo-url').value.trim();
  if (url) analyze(url);
});
$('btn-demo').addEventListener('click', loadDemo);
$('btn-cancel').addEventListener('click', () => { S.abort?.abort('cancel'); });
function toStart() {
  if (S.game) S.game.state = 'empty';
  $('gameover').hidden = true;
  show('start');
}
$('btn-new').addEventListener('click', toStart);
$('btn-over-new').addEventListener('click', toStart);
$('btn-rematch').addEventListener('click', () => { resetRound(); });
$('btn-over-watch').addEventListener('click', () => { $('gameover').hidden = true; $('hintbar').textContent = 'Game over. Hit New repo to play again.'; });

renderPlayers();
$('limit-seg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', Number(x.dataset.n) === S.limit));
$('hud').hidden = true;
