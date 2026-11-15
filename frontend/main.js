// main.js - UI orchestration: start screen, API, settings, HUD, panels, game-over.
import { Game, initPhysics, DEFAULT_RULES } from './game.js';
import { MAPPINGS, computePhysics } from './mapping.js';
import { selectDependencies, orderDependencies, buildLayout } from './tower.js';
import { KIND_LABELS, PLAYER_COLORS, cvssBand } from './theme.js';
import { lookFor, weightWord, gripWord, fragilityWord } from './appearance.js';
import { swatchURL } from './textures.js';
import { popLimit } from './fragility.js';
import { intensityLabel, DEFAULT_EXPLOITS } from './quake.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  json(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
};
const MAX_PLAYERS = 4;
const ALL = 9999; // "all dependencies" for the block limit
// Biggest tower allowed (= the backend's cap). Tested headless: ~500-block towers settle and hold with Rapier 0.21.
const MAX_TOWER = 500;

// ------------------------------------------------------------------ settings
const DEFAULT_SETTINGS = {
  players: DEFAULT_RULES.players,
  limit: 54,
  lockedRows: DEFAULT_RULES.lockedRows,
  placeOnTop: DEFAULT_RULES.placeOnTop,
  exploits: { ...DEFAULT_EXPLOITS },
  fragile: DEFAULT_RULES.fragile,
  theme: 'auto',
  graphics: 'balanced',
};
function loadSettings() {
  const saved = store.json('dj.settings', {});
  const s = { ...structuredClone(DEFAULT_SETTINGS), ...saved, exploits: { ...DEFAULT_EXPLOITS, ...(saved.exploits || {}) } };
  if (!saved.limit && Number(store.get('dj.limit', 0))) s.limit = Number(store.get('dj.limit', 0)); // older versions
  return s;
}
function saveSettings() { store.set('dj.settings', JSON.stringify(S.settings)); }
const rulesFromSettings = (st) => ({
  players: st.players, lockedRows: st.lockedRows, placeOnTop: st.placeOnTop, fragile: st.fragile, exploits: { ...st.exploits },
});

const savedNames = store.json('dj.names', null);
const S = {
  settings: loadSettings(),
  names: Array.from({ length: MAX_PLAYERS }, (_, i) => savedNames?.[i] || store.get(`dj.p${i + 1}`, '') || `Player ${i + 1}`),
  payload: null,
  current: 0,
  turn: 1,
  layout: null,
  game: null,
  abort: null,
  cap: null,
  items: null,
  source: null, // where the current tower came from: {repo} | {demo: true} | {data}
};
const playerName = (i) => S.names[i] || `Player ${i + 1}`;

// ------------------------------------------------------------------ URL parameters
// ?repo=<git url>  analyse that repo        ?demo  the demo tower        ?data=<url>  a saved analysis JSON
// ?players=2-4  ?blocks=<n>|all  ?locked=0-8  ?place=1|0  ?exploits=1|0  ?start=1-10  ?pace=gentle|normal|brutal
// ?fragile=1|0  ?theme=auto|light|dark  ?graphics=sharp|balanced|fast  ?names=Ann,Bob
// They apply for this visit only (saved settings are untouched unless you press Apply in the settings dialog).
const PACES = { gentle: 0.6, normal: 1, brutal: 1.6 };
const GRAPHICS = { sharp: 'high', high: 'high', balanced: 'balanced', fast: 'fast' };
const params = new URLSearchParams(location.search);
function applyParams(st) {
  const int = (k, lo, hi) => {
    const v = Number.parseInt(params.get(k), 10);
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null;
  };
  const bool = (k) => (params.has(k) ? !['0', 'false', 'no', 'off'].includes(params.get(k).toLowerCase()) : null);
  const set = (v, fn) => { if (v != null) fn(v); };
  set(int('players', 2, MAX_PLAYERS), (v) => { st.players = v; });
  if (params.get('blocks') === 'all') st.limit = ALL; else set(int('blocks', 5, MAX_TOWER), (v) => { st.limit = v; });
  set(int('locked', 0, 8), (v) => { st.lockedRows = v; });
  set(bool('place'), (v) => { st.placeOnTop = v; });
  set(bool('exploits'), (v) => { st.exploits.enabled = v; });
  set(int('start', 1, 10), (v) => { st.exploits.startRound = v; });
  const pace = params.get('pace');
  if (pace) st.exploits.pace = PACES[pace] ?? (Number(pace) > 0 ? Math.min(3, Number(pace)) : st.exploits.pace);
  set(bool('fragile'), (v) => { st.fragile = v; });
  if (['auto', 'light', 'dark'].includes(params.get('theme'))) st.theme = params.get('theme');
  if (GRAPHICS[params.get('graphics')]) st.graphics = GRAPHICS[params.get('graphics')];
  if (params.get('names')) params.get('names').split(',').slice(0, MAX_PLAYERS).forEach((n, i) => { if (n.trim()) S.names[i] = n.trim().slice(0, 16); });
}
applyParams(S.settings);

/** A link that recreates the current game: the tower's source plus every setting that differs from the defaults. */
function shareURL() {
  const q = new URLSearchParams();
  const src = S.source;
  if (src?.repo) q.set('repo', src.repo);
  else if (src?.data) q.set('data', src.data);
  else if (src?.demo) q.set('demo', '');
  const st = S.settings, d = DEFAULT_SETTINGS;
  if (st.players !== d.players) q.set('players', st.players);
  if (st.limit !== d.limit) q.set('blocks', st.limit >= ALL ? 'all' : st.limit);
  if (st.lockedRows !== d.lockedRows) q.set('locked', st.lockedRows);
  if (st.placeOnTop !== d.placeOnTop) q.set('place', st.placeOnTop ? 1 : 0);
  if (st.exploits.enabled !== d.exploits.enabled) q.set('exploits', st.exploits.enabled ? 1 : 0);
  if (st.exploits.startRound !== d.exploits.startRound) q.set('start', st.exploits.startRound);
  if (st.exploits.pace !== d.exploits.pace) q.set('pace', Object.keys(PACES).find((k) => PACES[k] === st.exploits.pace) || st.exploits.pace);
  if (st.fragile !== d.fragile) q.set('fragile', st.fragile ? 1 : 0);
  const names = S.names.slice(0, st.players);
  if (names.some((n, i) => n !== `Player ${i + 1}`)) q.set('names', names.join(','));
  const qs = q.toString().replace(/(^|&)demo=(&|$)/, '$1demo$2');
  return `${location.origin}${location.pathname}${qs ? `?${qs}` : ''}`;
}
function syncURL() {
  try { history.replaceState(null, '', shareURL()); } catch { /* sandboxed */ }
}

// ------------------------------------------------------------------ theme
const darkQuery = window.matchMedia?.('(prefers-color-scheme: dark)');
const THEME_ICON = { auto: '◐', light: '☀', dark: '☾' };
function isDark() {
  const t = S.settings.theme;
  return t === 'dark' || (t === 'auto' && !!darkQuery?.matches);
}
function applyTheme() {
  const t = S.settings.theme;
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  for (const id of ['btn-theme', 'btn-theme-start']) {
    $(id).textContent = THEME_ICON[t];
    $(id).title = `Theme: ${t} (click to change)`;
  }
  S.game?.setTheme(isDark());
}
function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  S.settings.theme = order[(order.indexOf(S.settings.theme) + 1) % order.length];
  saveSettings();
  applyTheme();
}
darkQuery?.addEventListener?.('change', applyTheme);
applyTheme();

// ------------------------------------------------------------------ legend ("reading a block")
/** One legend for everything a block's look tells you, with the data behind it. Swatches use the block drawing code. */
function lookLegendHTML() {
  const st = S.settings;
  const sw = (opts, cap = '') => `<figure><img src="${swatchURL(lookFor({ weight: 0.5, grip: 0.5, ...opts }))}" alt="">`
    + `<figcaption>${esc(cap)}</figcaption></figure>`;
  const row = (title, how, src, items, off = false) => `<div class="look-row">
      <div class="look-title"><b>${esc(title)}</b> <span class="how">&middot; ${esc(how)}</span>${off ? ' <span class="look-off">(off)</span>' : ''}</div>
      <div class="look-src">${src}</div>${items ? `<div class="look-sw">${items.join('')}</div>` : ''}</div>`;
  const locked = st.lockedRows ? `Your project and the top ${st.lockedRows} row${st.lockedRows === 1 ? '' : 's'} can't be pulled` : "Your project can't be pulled";
  return row('Weight', 'lightness', 'More imports and dependents &rarr; heavier',
    [sw({ weight: 0 }, 'light'), sw({ weight: 0.5 }, 'medium'), sw({ weight: 1 }, 'heavy')])
    + row('Friction', 'surface', 'More recent commits &rarr; more slippery',
      [sw({ grip: 0 }, 'slippery'), sw({ grip: 0.5 }), sw({ grip: 1 }, 'grippy')])
    + row('Fragility', 'cracks', 'More open issues + PRs &rarr; pops from a smaller knock',
      [sw({}, 'sturdy'), sw({ fragility: 0.55 }, 'fragile'), sw({ fragility: 1 }, 'glass')], !st.fragile)
    + row('Known CVEs', 'hue, score, glow',
      `Shake after every turn from round ${st.exploits.startRound}, harder each round; higher CVSS &rarr; harder`,
      [sw({}, 'none'), sw({ cvss: 4 }, 'medium'), sw({ cvss: 7.5 }, 'high'), sw({ cvss: 9.8 }, 'critical')], !st.exploits.enabled)
    + row('Locked', 'padlock', locked, [sw({ locked: true }, 'locked')])
    + row('Width', 'size', 'Bigger bundle &rarr; wider block', null);
}
function renderLegends() {
  const html = lookLegendHTML();
  $('look-legend').innerHTML = html;
  $('look-legend-start').innerHTML = html;
}
renderLegends();
// redraw the swatches once the hand-drawn font is in (their CVSS badges use it)
document.fonts?.load('40px "Patrick Hand"').then(renderLegends, () => {});

// ------------------------------------------------------------------ misc UI
let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

/** The status bar at the bottom: what's happening / what to do, marked with the current player's colour. */
function setStatus(text, player = S.current) {
  $('hintbar').textContent = text;
  $('status-dot').style.background = player == null ? 'var(--muted)' : PLAYER_COLORS[player];
}

function renderPlayers() {
  const box = $('players');
  const n = S.settings.players;
  if (box.children.length !== n) {
    box.innerHTML = Array.from({ length: n }, (_, i) => `<label class="player" data-i="${i}" style="--pc:${PLAYER_COLORS[i]}" title="Click the name to rename">
      <span class="dot"></span><input maxlength="16" value="${esc(playerName(i))}" aria-label="Player ${i + 1} name">
      <span class="pencil" aria-hidden="true">&#9998;</span><span class="badge">your turn</span></label>`).join('');
    box.querySelectorAll('.player').forEach((el) => {
      const i = Number(el.dataset.i);
      const input = el.querySelector('input');
      const fit = () => { input.style.width = `${Math.max(5, Math.min(16, input.value.length + 1))}ch`; };
      fit();
      input.addEventListener('input', () => {
        S.names[i] = input.value.trim() || `Player ${i + 1}`;
        store.set('dj.names', JSON.stringify(S.names));
        fit();
        if (S.source) syncURL();
      });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    });
  }
  box.querySelectorAll('.player').forEach((el) => el.classList.toggle('active', Number(el.dataset.i) === S.current));
}

function renderStatus() {
  if (!S.game) return;
  $('round-no').textContent = S.game.round();
  $('turn-no').textContent = S.turn;
  $('blocks-left').textContent = S.game.blocks.filter((x) => !x.removed).length;
}

// ------------------------------------------------------------------ screens
function show(which) {
  $('start').hidden = which !== 'start';
  $('loading').hidden = which !== 'loading';
  $('hud').hidden = which !== 'hud';
  if (which !== 'hud') $('gameover').hidden = true;
  if (which === 'start') renderSettingsSummary();
}
function showError(msg) {
  const e = $('start-error');
  e.textContent = msg;
  e.hidden = !msg;
}

// ------------------------------------------------------------------ data loading
const LOADING_MSGS = [
  'Cloning the repo...', 'Reading manifests and lockfiles...', 'Asking registries who depends on whom...',
  'Counting recent commits...', 'Weighing bundles...', 'Checking for known vulnerabilities...',
  'Looking for that one project in Nebraska...', 'Almost done stacking...',
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
  S.source = { repo: url };
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
  S.source = { demo: true };
  try {
    const res = await fetch('sample.json');
    if (!res.ok) throw new Error(`sample.json: ${res.status}`);
    await startGame(await res.json());
  } catch (err) {
    showError(`Could not load demo: ${err.message}`);
  }
}

/** A saved analysis (the JSON /api/analyze returns), e.g. to replay a repo offline or share a fixed snapshot. */
async function loadData(url) {
  showError('');
  S.source = { data: url };
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    if (!data || !Array.isArray(data.dependencies) || !data.dependencies.length) throw new Error('no dependencies in it');
    await startGame(data);
  } catch (err) {
    showError(`Could not load that analysis: ${err.message}`);
  }
}

// ------------------------------------------------------------------ game
async function ensureGame() {
  if (S.game) return S.game;
  await initPhysics();
  S.game = new Game($('view'), {
    onHover, onSelect: renderInfo, onHint: toast, onRemoved, onTurnEnd, onGameOver, onPullState, onQuake, onPop, onPlacing,
  });
  S.game.setTheme(isDark());
  S.game.setQuality(S.settings.graphics);
  window.__game = S.game; // debugging / tests
  return S.game;
}

async function startGame(payload) {
  S.payload = payload;
  try { await document.fonts.load('40px "Patrick Hand"'); } catch { /* font optional */ }
  await ensureGame();
  const repo = payload.repo || {};
  $('repo-name').textContent = repo.name || 'repository';
  if (repo.url) $('repo-name').href = repo.url; else $('repo-name').removeAttribute('href');
  $('repo-commit').textContent = repo.commit ? String(repo.commit).slice(0, 7) : '';
  $('repo-commit').hidden = !repo.commit;
  const w = payload.warnings || [];
  $('warnings').hidden = !w.length;
  $('warn-count').textContent = `${w.length} note${w.length === 1 ? '' : 's'} about the data`;
  $('warn-list').innerHTML = w.map((x) => `<li>${esc(x)}</li>`).join('');
  show('hud');
  $('legend-box').open = window.innerWidth > 860;
  buildTower();
  resetRound();
  S.game.resize();
  syncURL();
}

/** (Re)build the layout from the payload and the current settings. */
function buildTower() {
  const payload = S.payload;
  const chosen = selectDependencies(payload.dependencies, Math.min(S.settings.limit, MAX_TOWER));
  const phys = computePhysics(chosen);
  S.items = orderDependencies(chosen.map((dep, i) => ({ dep, phys: phys[i] })));
  S.cap = projectBlock(payload, chosen);
  S.layout = buildLayout(S.items, { capstone: S.cap });
  $('repo-meta').textContent = `${chosen.length} of ${payload.dependencies.length} dependencies in the tower`;
}

/** The analysed project itself, crowning the tower. Its physics are fixed rather than derived from metrics. */
function projectBlock(payload, chosen) {
  const repo = payload.repo || {};
  const name = repo.name || 'your project';
  const fixed = (value, t) => ({ value, t, level: t, raw: null, missing: true, mappingId: null });
  return {
    dep: {
      id: `project:${name}`, name, kind: 'project', ecosystem: repo.host || 'project',
      version: repo.commit ? String(repo.commit).slice(0, 7) : '', direct: true, repo_url: repo.url || null,
      description: 'The project you analysed. Everything below holds it up.',
      depends_on: chosen.filter((d) => d.direct).map((d) => d.id), metrics: {}, vulns: [],
    },
    phys: { width: fixed(1, 0.5), density: fixed(0.8, 0.1), friction: fixed(0.6, 0.75) },
  };
}

function resetRound() {
  S.current = 0;
  S.turn = 1;
  $('removed').hidden = true;
  $('removed-list').innerHTML = '';
  $('gameover').hidden = true;
  $('info').hidden = true;
  $('place-ui').hidden = true;
  $('btn-rematch-bar').hidden = true;
  S.game.configure(rulesFromSettings(S.settings));
  S.game.setPlayer(0);
  let rep = S.game.loadTower(S.layout, 0);
  if (!rep.stable && S.layout.mode === 'depth' && !S.layout.merged) {
    console.warn('[jenga] tower did not settle cleanly, merging singleton levels', rep);
    S.layout = buildLayout(S.items, { mergeSingletons: true, capstone: S.cap });
    S.layout.merged = true;
    rep = S.game.loadTower(S.layout, 0);
  }
  renderPlayers();
  renderStatus();
  renderExploit();
  setStatus(`${playerName(0)} starts: drag a block out of the tower in any direction (Shift lifts). Drag the background to orbit, scroll to zoom.`);
  console.info('[jenga] tower settled', S.game.settleReport, `layers=${S.layout.layers.length} mode=${S.layout.mode}`);
}

const fmtX = (i) => `×${i.toFixed(2)}`;
function renderExploit(active = false) {
  const el = $('exploit');
  const ex = S.settings.exploits;
  const n = S.game.vulnerable().length;
  el.hidden = !ex.enabled || (!n && !active);
  const level = active ? S.game.quakeIntensity : S.game.nextIntensity();
  const blocks = `${n} vulnerable block${n === 1 ? '' : 's'}`;
  el.classList.toggle('active', active);
  el.classList.toggle('calm', !active && level <= 0);
  el.classList.toggle('soon', !active && level >= 1.1);
  let text;
  if (active) text = `<b>EXPLOIT!</b> ${blocks} shaking: ${esc(intensityLabel(level))} (${fmtX(level)})`;
  else if (level <= 0) text = `No shaking until round ${ex.startRound} &middot; ${blocks}`;
  else text = `Shake after this turn: <b>${esc(intensityLabel(level))}</b> (${fmtX(level)}) &middot; ${blocks}`;
  $('exploit-text').innerHTML = text;
  $('exploit-meter').style.width = `${Math.round(Math.min(1, level / 2) * 100)}%`;
}

function onQuake(active, blocks, intensity) {
  renderExploit(active);
  if (active && intensity >= 0.35) { // faint early waves don't need announcing
    const worst = blocks.reduce((a, b) => (b.cvss > a.cvss ? b : a), blocks[0]);
    const cve = worst?.dep.vulns?.[0]?.id;
    toast(`Exploit: ${intensityLabel(intensity)} (${fmtX(intensity)})! ${blocks.length} vulnerable block${blocks.length === 1 ? ' is' : 's are'} shaking${cve ? ` (worst: ${worst.dep.name}, ${cve})` : ''}.`);
    setStatus('Hold on: known vulnerabilities are being exploited...', null);
  } else if (active) {
    setStatus(`The vulnerable blocks tremble (${intensityLabel(intensity)}, ${fmtX(intensity)})...`, null);
  } else {
    setStatus('Waiting for the tower to settle...', null);
  }
}

function onPullState(on, b) {
  if (on) setStatus(`${playerName(S.current)}: work ${b ? b.dep.name : 'it'} clear of the tower. Let go to stop.`);
}
function addRemoved(b, note = '', player = S.current) {
  $('removed').hidden = false;
  const style = player == null ? '' : ` style="color:${PLAYER_COLORS[player]}"`;
  $('removed-list').insertAdjacentHTML('beforeend',
    `<span class="rc${note ? ' popped' : ''}"${style}><i style="background:${b.color}"></i><span style="color:var(--ink)">${esc(b.dep.name)}</span>${note ? ` ${esc(note)}` : ''}</span>`);
}
function onRemoved(b) {
  addRemoved(b);
  renderStatus();
  renderExploit();
  if (!S.settings.placeOnTop) {
    setStatus(b.cvss != null ? `Patched out ${b.dep.name}. Waiting for the tower to settle...` : 'Nice. Waiting for the tower to settle...', null);
  }
}
function onPlacing(active, b) {
  $('place-ui').hidden = !active;
  if (active) setStatus(`${playerName(S.current)}: put ${b.dep.name} back on top. Move to aim, R rotates, click to drop.`);
  else setStatus('Waiting for the tower to settle...', null);
}
function onPop(b, { turn }) {
  addRemoved(b, 'popped', turn ? S.current : null);
  renderStatus();
  toast(`${b.dep.name} popped! (${fmtNum((b.dep.metrics?.open_issues ?? 0) + (b.dep.metrics?.open_prs ?? 0))} open issues + PRs)`);
  if (turn) setStatus(`${b.dep.name} shattered. Waiting for the tower to settle...`, null);
  renderExploit();
}

function onTurnEnd() {
  S.current = (S.current + 1) % S.settings.players;
  S.turn++;
  S.game.setPlayer(S.current);
  renderPlayers();
  renderStatus();
  renderExploit();
  setStatus(`${playerName(S.current)}'s turn. Pick a block you think is safe.`);
}

function onGameOver({ fallen, culprit, draw, quake, shaken, popped }) {
  renderExploit();
  $('place-ui').hidden = true;
  setStatus('Game over.', null);
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
  const loser = playerName(S.current);
  const lc = PLAYER_COLORS[S.current];
  const c = culprit.dep;
  const exploited = quake && shaken?.length ? shaken.reduce((a, b) => (b.cvss > a.cvss ? b : a), shaken[0]) : null;
  const vuln = exploited?.dep.vulns?.[0];
  $('over-title').innerHTML = exploited
    ? `<code>${esc(vuln?.id || 'A known vulnerability')}</code> in <code>${esc(exploited.dep.name)}</code> shook the tower down on <b style="color:${lc}">${esc(loser)}</b>'s watch.`
    : `<b style="color:${lc}">${esc(loser)}</b> pulled <code>${esc(c.name)}</code> and broke the internet.`;
  const pops = popped?.length ? ` ${popped.map((b) => esc(b.dep.name)).join(', ')} popped under the strain.` : '';
  const upstream = (exploited
    ? ` Last block pulled: ${esc(c.name)}.${fallen ? ` ${esc(fallen.dep.name)} was the first to fall.` : ''}`
    : fallen && fallen !== culprit ? ` ${esc(fallen.dep.name)} was the first to fall.` : '') + pops;
  const n = S.settings.players;
  const others = Array.from({ length: n }, (_, i) => i).filter((i) => i !== S.current).map((i) => esc(playerName(i)));
  const winners = n === 2 ? `${others[0]} wins.` : `${others.slice(0, -1).join(', ')} and ${others[others.length - 1]} survive.`;
  $('over-detail').innerHTML = `${esc(KIND_LABELS[c.kind] || c.kind)}${c.version ? ' ' + esc(c.version) : ''}, round ${S.game.round()}, turn ${S.turn}.${upstream}<br>${winners}`;
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

/** Words-plus-numbers descriptions of a block's gameplay properties (shared by tooltip and info panel). */
function describe(b) {
  const ph = b.phys;
  const lim = popLimit(b.fragility);
  const nv = b.dep.vulns?.length || 0;
  return {
    weight: `${weightWord(ph.density?.level)} (${b.mass.toFixed(1)})`,
    grip: `${gripWord(ph.friction?.level)} (${(ph.friction?.value ?? 0).toFixed(2)})`,
    fragility: S.settings.fragile ? (lim != null ? `${fragilityWord(b.fragility)}: pops above ${lim.toFixed(0)}g` : 'sturdy') : null,
    cve: nv ? `${cvssBand(b.cvss).label} ${b.cvss.toFixed(1)} (${nv} advisor${nv === 1 ? 'y' : 'ies'})` : null,
  };
}

function onHover(b, x, y) {
  const tip = $('tooltip');
  if (!b) { tip.hidden = true; return; }
  let body;
  if (b.cap) body = '<small>Your project: it rests on everything below and can\'t be pulled</small>';
  else {
    const d = describe(b);
    const rows = [['Weight', d.weight], ['Grip', d.grip]];
    if (d.fragility) rows.push(['Fragility', d.fragility]);
    if (d.cve) rows.push(['CVE', d.cve]);
    const lock = b.placed ? 'put back on top: stays there' : S.game.isLockedRow(b) ? `locked (top ${S.settings.lockedRows} rows)` : '';
    body = `<small>${esc(KIND_LABELS[b.dep.kind] || b.dep.kind)}${b.dep.version ? ` ${esc(b.dep.version)}` : ''}</small>
      <div class="tt">${rows.map(([k, v]) => `<span>${k}</span><span${k === 'CVE' || (k === 'Fragility' && v !== 'sturdy') ? ' class="warn"' : ''}>${esc(v)}</span>`).join('')}</div>
      ${lock ? `<small>${esc(lock)}</small>` : ''}`;
  }
  tip.innerHTML = `<b>${esc(b.dep.name)}</b>${body}`;
  tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, x + 16)) + 'px';
  tip.style.top = Math.max(8, Math.min(window.innerHeight - h - 8, y + 16)) + 'px';
}

function depLists(d) {
  const items = (S.items || []).concat(S.cap ? [S.cap] : []);
  const ids = new Set(items.map((it) => it.dep.id));
  const needs = (d.depends_on || []).filter((x) => ids.has(x));
  const users = items.filter((it) => (it.dep.depends_on || []).includes(d.id));
  const nm = (id) => esc(items.find((it) => it.dep.id === id)?.dep.name ?? id);
  const list = (label, arr) => (arr.length
    ? `<div class="desc"><b>${label}</b> ${arr.slice(0, 12).join(', ')}${arr.length > 12 ? ` +${arr.length - 12} more` : ''}</div>` : '');
  return list('Rests on:', needs.map(nm)) + list('Carries:', users.map((it) => esc(it.dep.name)));
}

function vulnsHTML(d) {
  const v = d.vulns || [];
  if (!v.length) return '';
  const shown = v.slice(0, 8).map((x) => {
    const band = cvssBand(x.cvss);
    const score = x.cvss == null ? '?' : `${band.label} ${x.cvss.toFixed(1)}${x.cvss_estimated ? '~' : ''}`;
    const other = x.osv_id && x.osv_id !== x.id ? ` (${esc(x.osv_id)})` : '';
    return `<div class="vuln" style="--sev:${band.color}"><div class="vh"><span><a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.id)}</a>${other}</span>
      <span class="score" title="CVSS${x.cvss_estimated ? ' (estimated from the severity label)' : ''}">${esc(score)}</span></div>
      ${x.summary ? `<small>${esc(x.summary)}</small>` : ''}</div>`;
  }).join('');
  const more = v.length > 8 ? `<small class="muted">+${v.length - 8} more</small>` : '';
  return `<div class="sec">Known vulnerabilities</div><div class="vulns">${shown}${more}</div>`;
}

const closeBtn = '<button class="icon-btn close" type="button" data-close aria-label="Close">&times;</button>';
function projectInfo(b) {
  const d = b.dep;
  const deps = S.items || [];
  const vulnDeps = deps.filter((it) => it.dep.vulns?.length);
  const cves = vulnDeps.reduce((a, it) => a + it.dep.vulns.length, 0);
  const row = (k, v) => `<tr><td>${k}</td><td>${v}</td></tr>`;
  return `${closeBtn}
    <h3>${esc(d.name)}</h3><div class="ver">${esc(d.version || '')}</div>
    <div class="chips"><span class="chip">${esc(KIND_LABELS.project)}</span><span class="chip">locked</span></div>
    <div class="desc">${esc(d.description)}</div>
    <table>
      ${row('Dependencies in the tower', fmtNum(deps.length))}
      ${row('Direct', fmtNum(deps.filter((it) => it.dep.direct).length))}
      ${row('With known vulnerabilities', fmtNum(vulnDeps.length))}
      ${row('Advisories', fmtNum(cves))}
    </table>
    ${depLists(d)}
    ${d.repo_url ? `<div class="desc"><a href="${esc(d.repo_url)}" target="_blank" rel="noopener noreferrer">${esc(d.repo_url.replace(/^https?:\/\//, ''))}</a></div>` : ''}`;
}

function renderInfo(b) {
  const el = $('info');
  if (!b) { el.hidden = true; return; }
  if (b.cap) { el.innerHTML = projectInfo(b); el.hidden = false; return; }
  const d = b.dep, m = d.metrics || {}, ph = b.phys;
  const desc = describe(b);
  const row = (k, v) => `<tr><td>${k}</td><td>${v}</td></tr>`;
  const commitsLabel = m.recent_commits_source === 'releases' ? 'Releases / year' : 'Commits (90d)';
  const physRow = (label, val, p, mapId) => {
    const mp = MAPPINGS.find((x) => x.id === mapId);
    return `<div class="phys"><div class="top"><span>${label}</span><b>${esc(val)}</b></div>
      <div class="bar"><i style="width:${Math.round((p?.level ?? p?.t ?? 0) * 100)}%"></i></div>
      <small>${mp ? `from ${esc(mp.label[0].toLowerCase() + mp.label.slice(1))}` : ''}${p?.missing ? ' (no data, default used)' : ''}</small></div>`;
  };
  const extra = MAPPINGS.filter((mp) => mp.enabled && !['width', 'density', 'friction', 'fragility'].includes(mp.prop))
    .map((mp) => physRow(esc(mp.target), ph[mp.prop].value.toFixed(2), ph[mp.prop], mp.id)).join('');
  el.innerHTML = `${closeBtn}
    <h3>${esc(d.name)}</h3><div class="ver">${esc(d.version || '')}</div>
    <div class="chips"><span class="chip">${esc(KIND_LABELS[d.kind] || d.kind)}</span>
      <span class="chip">${esc(d.ecosystem || '?')}</span><span class="chip">${d.direct ? 'direct' : 'transitive'}</span>
      <span class="chip">layer ${b.layer + 1}</span>${b.level != null ? `<span class="chip">depth ${b.level}</span>` : ''}
      ${S.game.isLockedRow(b) ? '<span class="chip">locked</span>' : ''}
      ${d.vulns?.length ? `<span class="chip cve">${d.vulns.length} CVE${d.vulns.length === 1 ? '' : 's'}</span>` : ''}</div>
    ${depLists(d)}
    ${d.description ? `<div class="desc">${esc(d.description)}</div>` : ''}
    <div class="sec">How it behaves</div>
    ${physRow('Width', `${b.w.toFixed(2)} units`, ph.width, 'size')}
    ${physRow('Weight', desc.weight, ph.density, 'uses')}
    ${physRow('Grip', desc.grip, ph.friction, 'commits')}
    ${ph.fragility && desc.fragility ? physRow('Fragility', desc.fragility, ph.fragility, 'backlog') : ''}
    ${extra}
    ${vulnsHTML(d)}
    <div class="sec">The data</div>
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
    ${d.repo_url ? `<div class="desc"><a href="${esc(d.repo_url)}" target="_blank" rel="noopener noreferrer">${esc(d.repo_url.replace(/^https?:\/\//, ''))}</a></div>` : ''}
  `;
  el.hidden = false;
}
$('info').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) S.game?.select(null); });

// ------------------------------------------------------------------ settings dialog
const dlg = $('settings');
let draft = null;
function maxBlocks() { return S.payload ? Math.max(5, Math.min(MAX_TOWER, S.payload.dependencies.length)) : MAX_TOWER; }
function limitText(v, max) {
  if (v < max) return String(v);
  if (!S.payload) return `${max} (max)`;
  return S.payload.dependencies.length > max ? `${max} (max)` : `all ${max}`;
}
function limitNote(v) {
  const n = S.payload?.dependencies.length;
  const base = n == null ? `Up to ${MAX_TOWER}, depending on the repo.`
    : n > MAX_TOWER ? `This repo has ${n} dependencies; the most significant ${MAX_TOWER} fit in a tower.`
      : `This repo has ${n} dependencies.`;
  return base + (v > 150 ? ' Very big towers are slower and wobblier.' : '');
}

function bindSeg(id, get, set) {
  const seg = $(id);
  const paint = () => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(get())));
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    set(b.dataset.v);
    paint();
    paintDraft();
  });
  return paint;
}
const segPainters = [
  bindSeg('set-players', () => draft.players, (v) => { draft.players = Number(v); }),
  bindSeg('set-pace', () => draft.exploits.pace, (v) => { draft.exploits.pace = Number(v); }),
  bindSeg('set-theme', () => draft.theme, (v) => { draft.theme = v; }),
  bindSeg('set-graphics', () => draft.graphics, (v) => { draft.graphics = v; }),
];

function paintDraft() {
  const max = maxBlocks();
  const lim = $('set-limit');
  lim.max = max;
  const v = Math.min(draft.limit, max);
  lim.value = v;
  $('set-limit-out').textContent = limitText(v, max);
  $('set-limit-note').textContent = limitNote(v);
  $('set-locked').value = draft.lockedRows;
  $('set-locked-out').textContent = draft.lockedRows;
  $('set-place').checked = draft.placeOnTop;
  $('set-exploits').checked = draft.exploits.enabled;
  $('set-start').value = draft.exploits.startRound;
  $('set-start-out').textContent = draft.exploits.startRound;
  $('set-fragile').checked = draft.fragile;
  for (const el of dlg.querySelectorAll('.field.indent')) {
    el.classList.toggle('disabled', !draft.exploits.enabled);
    el.querySelectorAll('input, button').forEach((x) => { x.disabled = !draft.exploits.enabled; });
  }
  segPainters.forEach((p) => p());
}

function openSettings() {
  draft = structuredClone(S.settings);
  if (draft.limit >= ALL) draft.limit = maxBlocks();
  $('settings-restart-note').hidden = !S.payload || $('hud').hidden;
  paintDraft();
  dlg.showModal();
}
$('set-limit').addEventListener('input', (e) => {
  const max = maxBlocks(), v = Number(e.target.value);
  draft.limit = v;
  $('set-limit-out').textContent = limitText(v, max);
  $('set-limit-note').textContent = limitNote(v);
});
$('set-locked').addEventListener('input', (e) => { draft.lockedRows = Number(e.target.value); $('set-locked-out').textContent = draft.lockedRows; });
$('set-place').addEventListener('change', (e) => { draft.placeOnTop = e.target.checked; });
$('set-exploits').addEventListener('change', (e) => { draft.exploits.enabled = e.target.checked; paintDraft(); });
$('set-start').addEventListener('input', (e) => { draft.exploits.startRound = Number(e.target.value); $('set-start-out').textContent = draft.exploits.startRound; });
$('set-fragile').addEventListener('change', (e) => { draft.fragile = e.target.checked; });
dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'apply' || !draft) return;
  if (draft.limit >= maxBlocks()) draft.limit = ALL;
  const displayOnly = JSON.stringify({ ...draft, theme: 0, graphics: 0 }) === JSON.stringify({ ...S.settings, theme: 0, graphics: 0 });
  S.settings = draft;
  draft = null;
  saveSettings();
  applyTheme();
  S.game?.setQuality(S.settings.graphics);
  renderLegends();
  renderSettingsSummary();
  if (!displayOnly && S.payload && !$('hud').hidden) { buildTower(); resetRound(); }
  if (S.payload && !$('hud').hidden) syncURL();
});

function renderSettingsSummary() {
  const st = S.settings;
  const bits = [`${st.players} players`, `${st.limit >= ALL ? 'all' : st.limit} blocks`];
  if (st.placeOnTop) bits.push('place on top');
  if (!st.exploits.enabled) bits.push('no exploits');
  if (!st.fragile) bits.push('no popping');
  $('settings-summary').textContent = bits.join(' · ');
}

// ------------------------------------------------------------------ wiring
$('analyze-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = $('repo-url').value.trim();
  if (url) analyze(url);
});
$('btn-demo').addEventListener('click', loadDemo);
$('btn-cancel').addEventListener('click', () => { S.abort?.abort('cancel'); });
$('btn-settings').addEventListener('click', openSettings);
$('btn-settings-start').addEventListener('click', openSettings);
$('btn-theme').addEventListener('click', cycleTheme);
$('btn-link').addEventListener('click', async () => {
  const url = shareURL();
  try { await navigator.clipboard.writeText(url); toast('Link copied: it opens this repo with these settings.'); }
  catch { window.prompt('Copy this link:', url); }
});
$('btn-theme-start').addEventListener('click', cycleTheme);
$('btn-rotate').addEventListener('click', () => S.game?.rotatePlacement());
$('btn-drop').addEventListener('click', () => S.game?.dropPlacement());
function toStart() {
  if (S.game) S.game.state = 'empty';
  $('gameover').hidden = true;
  S.source = null;
  syncURL();
  show('start');
}
$('btn-new').addEventListener('click', toStart);
$('btn-over-new').addEventListener('click', toStart);
$('btn-rematch').addEventListener('click', () => { resetRound(); });
$('btn-over-watch').addEventListener('click', () => { $('gameover').hidden = true; $('btn-rematch-bar').hidden = false; setStatus('Game over.', null); });
$('btn-rematch-bar').addEventListener('click', () => { resetRound(); });

renderPlayers();
renderSettingsSummary();
$('hud').hidden = true;

// open whatever the URL asks for (see "URL parameters" above)
if (params.get('repo')) { $('repo-url').value = params.get('repo'); analyze(params.get('repo').trim()); }
else if (params.get('data')) loadData(params.get('data'));
else if (params.has('demo')) loadDemo();
