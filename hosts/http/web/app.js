/* 全息记忆 · 独立面板
 * 只读展示：列表 / 搜索 / 星图 / 规则。写入仍走 MCP 工具或 POST 路由。
 *
 * 星图移植自插件的 MemoryGraph（client.js）：四旋臂、透视投影、惯性拖拽、
 * 闲置自转。原实现是 React，这里换成等价的普通 canvas 循环，算法不变。
 */

const state = {
  tab: 'list',
  query: '',
  scope: 'all',
  audit: false,
  mapScope: 'all',
  mapLoaded: false,
};

const $ = id => document.getElementById(id);

async function api(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error(`${path} → ${response.status}`);
  return response.json();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* ---------- 统计 ---------- */

async function loadStats() {
  try {
    const status = await api('/omni-memory/status');
    const stats = status.stats ?? {};
    const box = $('stats');
    box.replaceChildren();
    for (const [label, value] of [['笔记', stats.notes], ['事实', stats.facts], ['转录', stats.chunks]]) {
      const cell = el('span');
      cell.append(label + ' ');
      cell.append(el('b', null, String(value ?? 0)));
      box.append(cell);
    }
  } catch { /* 面板本身不因统计失败而空白 */ }
}

/* ---------- 列表与搜索 ---------- */

function rowFor(item) {
  const row = el('div', `row ${item.kind}`);
  row.append(el('div', 'kind', item.kind));
  const body = el('div', 'body');

  let text = String(item.text ?? '');
  if (item.kind === 'fact') text = `${item.subject} ${item.relation} ${item.object}`;
  body.append(el('div', 'text', text));

  const meta = el('div', 'meta');
  const bits = [];
  if (item.kind !== 'chunk' && item.id != null) bits.push(`#${item.id}`);
  if (item.scope) bits.push(item.scope === 'global' ? 'global' : String(item.scope).replace(/^proj:/, ''));
  if (item.source) bits.push(item.source);
  if (item.solutionStatus && item.solutionStatus !== 'unverified') bits.push(item.solutionStatus);
  if (item.contested) bits.push('contested');
  if (item.superseded_by) bits.push(`被 #${item.superseded_by} 替代`);
  if (item.valid_to) bits.push('已失效');
  for (const bit of bits) meta.append(el('span', null, bit));

  body.append(meta);
  row.append(body);
  return row;
}

async function loadList() {
  const box = $('list');
  box.replaceChildren(el('div', 'empty', '加载中…'));

  try {
    const params = new URLSearchParams({ limit: '60', scope: state.scope });
    if (state.audit) params.set('audit', '1');

    let items = [];
    if (state.query.trim()) {
      const search = new URLSearchParams({ q: state.query.trim(), limit: '40' });
      if (state.scope !== 'all') search.set('scope', state.scope);
      const result = await api(`/omni-memory/search?${search}`);
      items = result.hits ?? [];
    } else {
      const result = await api(`/omni-memory/list?${params}`);
      items = [...(result.notes ?? []), ...(result.facts ?? []), ...(result.chunks ?? [])];
    }

    box.replaceChildren();
    if (!items.length) {
      box.append(el('div', 'empty', state.query ? '没有匹配的记忆' : '还没有任何记忆'));
      return;
    }
    for (const item of items) box.append(rowFor(item));
  } catch (err) {
    box.replaceChildren(el('div', 'empty', `读取失败：${err.message}`));
  }
}

/* ---------- 星图（移植 MemoryGraph） ---------- */

const canvas = $('map');
const ctx = canvas.getContext('2d');

function galaxyRng(seed) {
  let t = (seed + 0x6d2b79f5) | 0;
  return () => {
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Spiral-arm placement: four arms, sqrt radius for even density, arm width and
 * vertical thickness falling off outward. Same recipe as the plugin's graph.
 */
function galaxyPoint(index, radiusMin) {
  const arms = 4;
  const rand = galaxyRng(Math.imul(index + 1, 2654435761));
  const r = radiusMin + Math.sqrt(rand()) * (0.98 - radiusMin);
  const arm = index % arms;
  const angle = (arm * Math.PI * 2) / arms + r * 2.6 + (rand() - 0.5) * 0.34;
  const thickness = (1 - r * 0.62) * 0.17;
  return {
    x: Math.cos(angle) * r,
    y: (rand() - 0.5) * thickness * 2,
    z: Math.sin(angle) * r,
    r,
    phase: rand() * Math.PI * 2,
  };
}

const map = {
  nodes: [],
  links: [],
  stars: [],
  scopes: [],
  hoverId: null,
  selectedId: null,
  raf: 0,
  spin: true,
  view: {
    yaw: 0.35, pitch: -0.55, zoom: 1.05,
    
    vx: 0.0011, vy: 0.0001,
    dragging: false, moved: false,
    lastX: 0, lastY: 0, downX: 0, downY: 0, lastMove: 0,
    screen: new Map(), linkScreen: [],
    w: 0, h: 0, dpr: 1,
    stride: 1, slowFrames: 0, frameTime: 16,
  },
};

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const view = map.view;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  view.w = rect.width;
  view.h = rect.height;
  view.dpr = dpr;
  canvas.width = Math.round(view.w * dpr);
  canvas.height = Math.round(view.h * dpr);
}

function project(point) {
  const view = map.view;
  const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw);
  const cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
  const x1 = point.x * cy - point.z * sy;
  const z1 = point.x * sy + point.z * cy;
  const y2 = point.y * cp - z1 * sp;
  const z2 = point.y * sp + z1 * cp;
  const radius = Math.min(view.w * 0.55, view.h * 0.82) * view.zoom;
  const perspective = 1 / (1.65 - z2 * 0.55);
  return {
    x: view.w / 2 + x1 * radius * perspective,
    y: view.h / 2 + y2 * radius * perspective,
    z: z2,
    scale: perspective,
  };
}

function paintNebula(cx, cy, radius, rgb, alpha) {
  const view = map.view;
  const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  gradient.addColorStop(0, `rgba(${rgb},${alpha})`);
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, view.w, view.h);
}

function render(time) {
  const view = map.view;
  if (!view.w || !view.h) return;

  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#05060f';
  ctx.fillRect(0, 0, view.w, view.h);

  paintNebula(view.w * 0.5, view.h * 0.52, Math.min(view.w, view.h) * 0.55, '74,58,160', 0.30);
  paintNebula(view.w * 0.62, view.h * 0.42, Math.min(view.w, view.h) * 0.34, '36,110,180', 0.22);

  // Warm nucleus, the same trick the three.js galaxy uses to read as a galaxy
  // rather than a flat constellation.
  const coreRadius = Math.min(view.w, view.h) * 0.12 * view.zoom;
  const coreGlow = ctx.createRadialGradient(view.w / 2, view.h / 2, 0, view.w / 2, view.h / 2, coreRadius);
  coreGlow.addColorStop(0, 'rgba(255,228,180,0.55)');
  coreGlow.addColorStop(0.3, 'rgba(255,190,110,0.22)');
  coreGlow.addColorStop(1, 'rgba(255,170,80,0)');
  ctx.fillStyle = coreGlow;
  ctx.fillRect(0, 0, view.w, view.h);

  const screenNodes = new Map();
  for (const node of map.nodes) screenNodes.set(node.id, project(node));
  view.screen = screenNodes;

  ctx.globalCompositeOperation = 'lighter';
  const twinkle = time * 0.0016;
  for (let index = 0; index < map.stars.length; index += view.stride) {
    const star = map.stars[index];
    const point = project(star);
    const depth = 1 - (point.z + 1) / 2;
    const alpha = Math.max(0.06, (0.46 + depth * 0.6) * star.bright * (0.75 + 0.25 * Math.sin(twinkle + star.phase)));
    const size = Math.max(0.5, star.size * point.scale * view.zoom * view.stride * 1.1);
    ctx.fillStyle = star.warm
      ? `rgba(255,214,170,${alpha.toFixed(3)})`
      : `rgba(150,190,255,${alpha.toFixed(3)})`;
    ctx.fillRect(point.x, point.y, size, size);
  }

  const labels = new Map(map.nodes.map(node => [node.id, node.label]));
  const linkScreen = [];
  for (const link of map.links) {
    const a = screenNodes.get(link.source);
    const b = screenNodes.get(link.target);
    if (!a || !b) continue;
    const mention = link.rel === 'mentions';
    const depth = 1 - (a.z + b.z) / 2;
    const base = 0.05 + depth * 0.22;
    ctx.setLineDash(mention ? [3, 4] : []);
    ctx.strokeStyle = mention
      ? `rgba(140,232,255,${base.toFixed(3)})`
      : `rgba(120,170,255,${(base * 1.1).toFixed(3)})`;
    ctx.lineWidth = mention ? 1 : 1.2;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    if (!mention) {
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const size = 5;
      ctx.fillStyle = `rgba(140,185,255,${(base * 1.4).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - Math.cos(angle - 0.42) * size, b.y - Math.sin(angle - 0.42) * size);
      ctx.lineTo(b.x - Math.cos(angle + 0.42) * size, b.y - Math.sin(angle + 0.42) * size);
      ctx.closePath();
      ctx.fill();
    }
    linkScreen.push({
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      rel: link.rel,
      from: labels.get(link.source) ?? link.source,
      to: labels.get(link.target) ?? link.target,
      mention,
    });
  }
  view.linkScreen = linkScreen;

  for (const node of map.nodes) {
    const point = screenNodes.get(node.id);
    const isMarked = node.id === map.selectedId;
    const isHovered = node.id === map.hoverId;
    const depth = 1 - (point.z + 1) / 2;
    const twinkleAlpha = 0.8 + 0.2 * Math.sin(twinkle * 1.7 + node.weight * 9);
    const base = Math.min(1, 0.45 + depth * 0.75) * twinkleAlpha;
    const rgb = node.kind === 'note' ? '95,216,255' : '255,196,110';
    const core = (1.4 + node.weight * 3.4) * point.scale * view.zoom;

    ctx.fillStyle = `rgba(${rgb},${(0.10 * base).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(point.x, point.y, core * 4.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(${rgb},${(0.30 * base).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(point.x, point.y, core * 2.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(255,255,255,${(0.85 * base).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(point.x, point.y, Math.max(0.7, core * 0.55), 0, Math.PI * 2);
    ctx.fill();

    if (isMarked || isHovered) {
      const pulse = 0.5 + 0.5 * Math.sin(time * 0.004 + node.weight * 6);
      ctx.strokeStyle = `rgba(125,255,205,${(0.30 + 0.45 * pulse).toFixed(3)})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(point.x, point.y, core * 6.5 + 2 + pulse * 3, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  ctx.globalCompositeOperation = 'source-over';
  if (!map.nodes.length) {
    ctx.fillStyle = 'rgba(150,170,200,.85)';
    ctx.font = '12px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('暂无图谱数据：先写入几条事实或笔记', view.w / 2, view.h / 2);
    ctx.textAlign = 'start';
  }

  // Idle spin with inertia, exactly as the plugin does it.
  if (!view.dragging && map.spin) {
    view.yaw += view.vx;
    view.pitch = Math.max(-1.3, Math.min(1.3, view.pitch + view.vy));
    view.vx *= 0.985;
    view.vy *= 0.985;
    if (Date.now() - view.lastMove > 2500) view.yaw += 0.0016;
  }
}

function step(time) {
  const view = map.view;
  const delta = Math.max(1, time - (map.last || time));
  map.last = time;

  view.frameTime = view.frameTime * 0.92 + delta * 0.08;
  if (view.frameTime > 34) {
    view.slowFrames += 1;
    if (view.slowFrames > 90 && view.stride < 3) {
      view.stride += 1;
      view.slowFrames = 0;
    }
  } else if (view.frameTime < 20) {
    view.slowFrames = Math.max(0, view.slowFrames - 1);
  }

  try { render(time); } catch { stopMap(); return; }
  map.raf = requestAnimationFrame(step);
}

function startMap() {
  if (map.raf) return;
  map.last = 0;
  map.raf = requestAnimationFrame(step);
}

function stopMap() {
  if (!map.raf) return;
  cancelAnimationFrame(map.raf);
  map.raf = 0;
}

async function loadMap() {
  try {
    const scope = state.mapScope || 'all';
    const body = await api(`/omni-memory/graph?scope=${encodeURIComponent(scope)}`);
    if (!body?.ok) throw new Error('graph unavailable');

    map.scopes = Array.isArray(body.scopes) ? body.scopes : [];
    map.nodes = (body.nodes ?? []).map((node, index) => ({ ...node, ...galaxyPoint(index + 11, 0.18) }));
    map.links = body.links ?? [];
    map.stars = [];
    for (let index = 0; index < 12000; index += 1) {
      const point = galaxyPoint(index, 0.06);
      const rand = galaxyRng(Math.imul(index + 3, 40503));
      map.stars.push({ ...point, size: 0.7 + rand() * 1.9, warm: point.r < 0.5, bright: 0.3 + rand() * 0.7 });
    }

    const select = $('mapScope');
    const current = state.mapScope;
    select.replaceChildren(new Option('全部层级', 'all'));
    for (const layer of map.scopes) {
      if (!layer.key) continue;
      const label = layer.key === 'global' ? 'global' : String(layer.key).replace(/^proj:/, '').split('#')[0];
      select.append(new Option(`${label}（${(layer.facts ?? 0) + (layer.notes ?? 0)}）`, layer.key));
    }
    select.value = current;

    state.mapLoaded = true;
    $('mapHint').textContent = `${map.nodes.length} 个节点 · 拖拽旋转 · 滚轮缩放 · 点击节点查看详情`;
    resizeCanvas();
    if (state.tab === 'map') startMap();
  } catch (err) {
    $('mapHint').textContent = `图谱读取失败：${err.message}`;
  }
}

/* ---------- 星图交互 ---------- */

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  if (!lengthSq) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function hitNode(x, y, limit = 16) {
  let best = null;
  let bestDistance = limit;
  for (const [id, point] of map.view.screen) {
    const distance = Math.hypot(point.x - x, point.y - y);
    if (distance < bestDistance) { bestDistance = distance; best = id; }
  }
  return best;
}

function hover(event) {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;

  const id = hitNode(x, y);
  if (id) {
    const node = map.nodes.find(item => item.id === id);
    map.hoverId = id;
    if (node) $('mapHint').textContent = `${node.kind === 'entity' ? '实体' : '笔记'} · ${String(node.label ?? '').slice(0, 60)}`;
    canvas.style.cursor = 'pointer';
    return;
  }

  map.hoverId = null;
  canvas.style.cursor = map.view.dragging ? 'grabbing' : 'grab';

  let line = null;
  let lineDistance = 10;
  for (const entry of map.view.linkScreen) {
    const distance = distanceToSegment(x, y, entry.x1, entry.y1, entry.x2, entry.y2);
    if (distance < lineDistance) { lineDistance = distance; line = entry; }
  }
  if (line) {
    $('mapHint').textContent = line.mention ? `${line.from} 提到 ${line.to}` : `${line.from} —${line.rel}→ ${line.to}`;
  } else {
    $('mapHint').textContent = `${map.nodes.length} 个节点 · 拖拽旋转 · 滚轮缩放 · 点击节点查看详情`;
  }
}

canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  const view = map.view;
  view.dragging = true;
  view.moved = false;
  view.downX = event.clientX;
  view.downY = event.clientY;
  view.lastX = event.clientX;
  view.lastY = event.clientY;
  view.lastMove = Date.now();
  try { canvas.setPointerCapture(event.pointerId); } catch { /* synthetic pointers */ }
});

canvas.addEventListener('pointermove', event => {
  const view = map.view;
  if (view.dragging) {
    const dx = event.clientX - view.lastX;
    const dy = event.clientY - view.lastY;
    if (Math.hypot(event.clientX - view.downX, event.clientY - view.downY) > 4) view.moved = true;
    view.lastX = event.clientX;
    view.lastY = event.clientY;
    view.yaw += dx * 0.006;
    view.pitch = Math.max(-1.3, Math.min(1.3, view.pitch + dy * 0.005));
    view.vx = dx * 0.0007;
    view.vy = dy * 0.0003;
    view.lastMove = Date.now();
    canvas.style.cursor = 'grabbing';
    return;
  }
  hover(event);
});

canvas.addEventListener('pointerup', event => {
  const view = map.view;
  const wasDrag = view.moved;
  view.dragging = false;
  view.lastMove = Date.now();
  if (wasDrag) return;

  const rect = canvas.getBoundingClientRect();
  const id = hitNode(event.clientX - rect.left, event.clientY - rect.top, 18);
  if (!id) return;
  const node = map.nodes.find(item => item.id === id);
  if (!node) return;
  map.selectedId = id;
  inspect(node);
});

canvas.addEventListener('pointerleave', () => {
  map.view.dragging = false;
  map.hoverId = null;
  canvas.style.cursor = 'grab';
});

canvas.addEventListener('wheel', event => {
  event.preventDefault();
  const view = map.view;
  view.zoom = Math.max(0.45, Math.min(2.8, view.zoom * (event.deltaY > 0 ? 0.92 : 1.08)));
}, { passive: false });

async function inspect(node) {
  const hint = $('mapHint');
  if (node.kind !== 'entity') {
    hint.textContent = `#${node.id} · ${String(node.label ?? '').slice(0, 120)}`;
    return;
  }
  const name = String(node.id).replace(/^e:/, '');
  try {
    const data = await api(`/omni-memory/node?node=${encodeURIComponent(name)}${state.mapScope && state.mapScope !== 'all' ? `&scope=${encodeURIComponent(state.mapScope)}` : ''}`);
    const facts = (data.node?.facts ?? []).length;
    hint.textContent = `${name} · ${facts} 条事实`;
  } catch {
    hint.textContent = name;
  }
}

/* ---------- 规则 ---------- */

async function loadRules() {
  try {
    const text = await (await fetch('/rules')).text();
    $('rules').textContent = text;
  } catch (err) {
    $('rules').textContent = `读取失败：${err.message}`;
  }
}

/* ---------- 交互 ---------- */

function activateTab(name) {
  state.tab = name;
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('is-active', tab.dataset.tab === name);
  for (const panel of document.querySelectorAll('.panel')) panel.classList.toggle('is-active', panel.id === `panel-${name}`);

  if (name === 'map') {
    if (!state.mapLoaded) loadMap();
    else { resizeCanvas(); startMap(); }
  } else {
    stopMap();
  }
  if (name === 'rules') loadRules();
  if (name === 'list') loadList();
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => activateTab(tab.dataset.tab));
}

let timer = null;
$('q').addEventListener('input', event => {
  clearTimeout(timer);
  const value = event.target.value;
  timer = setTimeout(() => { state.query = value; loadList(); }, 220);
});

$('scope').addEventListener('change', event => { state.scope = event.target.value; loadList(); });
$('audit').addEventListener('change', event => { state.audit = event.target.checked; loadList(); });
$('mapScope').addEventListener('change', event => {
  state.mapScope = event.target.value || 'all';
  state.mapLoaded = false;
  map.view.yaw = 0.35;
  map.view.pitch = -0.32;
  map.view.zoom = 1.05;
  loadMap();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopMap();
  else if (state.tab === 'map') startMap();
});

window.addEventListener('resize', () => { if (state.tab === 'map') resizeCanvas(); });
try {
  const observer = new ResizeObserver(() => { if (state.tab === 'map') resizeCanvas(); });
  observer.observe(canvas.parentElement);
} catch { /* older browsers keep the resize listener */ }

loadStats();
setInterval(loadStats, 30_000);

const requestedTab = new URLSearchParams(location.search).get('tab') ?? location.hash.replace('#', '');
activateTab(['list', 'map', 'rules'].includes(requestedTab) ? requestedTab : 'list');

// Debug handle: the panel is read-only and local, and this makes the star map
// testable from a headless browser without a test-only build.
window.__omni = { map, state, activateTab };
