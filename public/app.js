/* Monitor de la red eléctrica — cliente */
'use strict';

// ---------------- Utilidades ----------------
const $ = s => document.querySelector(s);
const TZ = 'Europe/Madrid';
const nf0 = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0, useGrouping: 'always' });
const nf1 = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: 'always' });
const nf2 = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf3 = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const MINUS = '−';
const signed = (v, f = nf1) => (v > 0 ? '+' : v < 0 ? MINUS : '') + f.format(Math.abs(v));
const pct = (v, f = nf1) => `${signed(v, f)} %`;
const cls = v => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const hm = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const hShort = m => `${Math.floor(m / 60)}.${String(m % 60).padStart(2, '0')}`;
const gw = v => nf1.format(v / 1000);

function madridNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}
function addDays(date, n) {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const dow = date => new Date(date + 'T12:00:00Z').getUTCDay();
const dateObj = date => new Date(date + 'T12:00:00Z');
const fmtDay = (date, opts = { weekday: 'long', day: 'numeric', month: 'long' }) =>
  new Intl.DateTimeFormat('es-ES', { ...opts, timeZone: 'UTC' }).format(dateObj(date));
const fmtMonth = (m, opts = { month: 'long', year: 'numeric' }) =>
  new Intl.DateTimeFormat('es-ES', { ...opts, timeZone: 'UTC' }).format(new Date(m + '-15T12:00:00Z'));
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
  return j;
}
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

// ---------------- Tooltip ----------------
const tip = {
  el: $('#tooltip'),
  show(html, ev) {
    this.el.innerHTML = html;
    this.el.classList.add('show');
    const r = this.el.getBoundingClientRect();
    const pad = 12, vw = window.innerWidth, vh = window.innerHeight;
    let x = ev.clientX + 16, y = ev.clientY - r.height - 12;
    if (x + r.width > vw - pad) x = ev.clientX - r.width - 16;
    if (x < pad) x = pad;
    if (y < pad) y = ev.clientY + 18;
    if (y + r.height > vh - pad) y = vh - r.height - pad;
    this.el.style.left = x + 'px';
    this.el.style.top = y + 'px';
  },
  hide() { this.el.classList.remove('show'); },
};
const ttRow = (label, value, color, dash) =>
  `<div class="tt-r"><span>${color ? `<i style="background:${dash ? `repeating-linear-gradient(90deg,${color} 0 3px,transparent 3px 5px)` : color}"></i>` : ''}${label}</span><b>${value}</b></div>`;
document.addEventListener('scroll', () => tip.hide(), { passive: true });

// ---------------- Render helpers ----------------
const renderers = new Map();
const lastW = new WeakMap();
const ro = new ResizeObserver(entries => {
  for (const e of entries) {
    const w = Math.round(e.contentRect.width);
    if (lastW.get(e.target) === w) continue;
    lastW.set(e.target, w);
    const fn = renderers.get(e.target);
    if (fn) requestAnimationFrame(fn);
  }
});
function register(el, fn) {
  if (!renderers.has(el)) ro.observe(el);
  renderers.set(el, fn);
  fn();
}
function svgIn(el) {
  el.innerHTML = '';
  const w = Math.max(80, el.clientWidth), h = el.clientHeight;
  const svg = d3.select(el).append('svg').attr('width', w).attr('height', h).attr('viewBox', `0 0 ${w} ${h}`);
  return { svg, w, h };
}
const placeholder = (el, text, loading = false) => { el.innerHTML = `<div class="${loading ? 'loading' : 'empty'}">${text}</div>`; };
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---------------- Estado ----------------
const state = {
  date: madridNow().date,
  refresh: Number(store.get('refresh') ?? 60),
  show: { yday: true, week: true, prog: false, tariff: false },
  rt: null, prices: null, mix: null, mixDay: null, systems: null, national: null, regions: null, ire: null,
  nextAt: 0, lastOk: 0, error: null,
};
const isToday = () => state.date === madridNow().date;

// ---------------- Tarifa 2.0TD ----------------
const HOLIDAYS = ['01-01', '01-06', '05-01', '08-15', '10-12', '11-01', '12-06', '12-08', '12-25'];
function tariffBands(date) {
  const wd = dow(date);
  if (wd === 0 || wd === 6 || HOLIDAYS.includes(date.slice(5))) return [[0, 1440, 3]];
  return [[0, 480, 3], [480, 600, 2], [600, 840, 1], [840, 1080, 2], [1080, 1320, 1], [1320, 1440, 2]];
}

// ---------------- Cálculos de demanda ----------------
function rtCalc() {
  const t = state.rt?.today;
  if (!t || !t.real.length) return null;
  const prev = new Map(t.prevista.map(x => [x.m, x.v]));
  const real = t.real;
  const last = real[real.length - 1];
  const paired = real.filter(x => prev.has(x.m));
  const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
  const lastHour = paired.slice(-12);
  const hourDev = lastHour.length ? (sum(lastHour, x => x.v) / sum(lastHour, x => prev.get(x.m)) - 1) * 100 : null;
  const dayDev = paired.length ? (sum(paired, x => x.v) / sum(paired, x => prev.get(x.m)) - 1) * 100 : null;
  const yMap = new Map((state.rt.yday?.real || []).map(x => [x.m, x.v]));
  const vsY = yMap.has(last.m) ? (last.v / yMap.get(last.m) - 1) * 100 : null;
  const max = real.reduce((a, b) => (b.v > a.v ? b : a), real[0]);
  const min = real.reduce((a, b) => (b.v < a.v ? b : a), real[0]);
  const pmax = t.prevista.length ? t.prevista.reduce((a, b) => (b.v > a.v ? b : a), t.prevista[0]) : null;
  const energy = sum(real, x => x.v) / 12; // MWh (5 min = 1/12 h)
  const devs = paired.map(x => ({ m: x.m, d: x.v - prev.get(x.m), p: prev.get(x.m) }));
  return { last, prev, hourDev, dayDev, vsY, max, min, pmax, energy, devs, paired };
}

// ---------------- KPIs ----------------
function kpi(label, value, sub = '', valueCls = '') {
  return `<div class="kpi"><div class="k-label">${label}</div><div class="k-value ${valueCls}">${value}</div><div class="k-sub">${sub}</div></div>`;
}
function renderKPIs() {
  const el = $('#kpis');
  const c = rtCalc();
  const out = [];
  if (c) {
    const today = isToday();
    out.push(kpi(today ? 'Demanda ahora' : `Demanda a las ${hm(c.last.m)}`, `${nf0.format(c.last.v)}<small>MW</small>`, today ? `dato de las ${hm(c.last.m)} h` : fmtDay(state.date, { day: 'numeric', month: 'short' })));
    out.push(kpi('Última hora vs previsto', c.hourDev == null ? '—' : pct(c.hourDev), 'media de 12 intervalos', cls(c.hourDev)));
    out.push(kpi('En el día vs previsto', c.dayDev == null ? '—' : pct(c.dayDev), `${nf1.format(c.energy / 1000)} GWh consumidos`, cls(c.dayDev)));
    out.push(kpi('Frente a ayer', c.vsY == null ? '—' : pct(c.vsY), `a la misma hora`, cls(c.vsY)));
    out.push(kpi(today ? 'Máximo hasta ahora' : 'Máximo del día', `${nf0.format(c.max.v)}<small>MW</small>`, `a las ${hm(c.max.m)}${c.pmax ? ` · previsto ${gw(c.pmax.v)} GW (${hm(c.pmax.m)})` : ''}`));
  } else {
    for (let i = 0; i < 5; i++) out.push(`<div class="kpi skeleton"><div class="k-label">Cargando…</div><div class="k-value">00000</div><div class="k-sub">&nbsp;</div></div>`);
  }
  const p = state.prices;
  if (p && p.spot.length) {
    const nowM = isToday() ? madridNow().minute : null;
    const spotNow = nowM != null ? [...p.spot].reverse().find(x => x.m <= nowM) : null;
    const pvNow = nowM != null ? [...p.pvpc].reverse().find(x => x.m <= nowM) : null;
    const avg = d3.mean(p.spot, x => x.v);
    out.push(kpi(spotNow ? 'Precio mayorista ahora' : 'Precio mayorista medio', `${nf1.format(spotNow ? spotNow.v : avg)}<small>€/MWh</small>`, pvNow ? `PVPC ${nf3.format(pvNow.v / 1000)} €/kWh` : `media del día`));
  }
  const mx = state.mix && mixDayStats(state.mixDay);
  if (mx) {
    out.push(kpi('Renovables', `${nf1.format(mx.renShare)}<small>%</small>`, `de la generación · ${dayLabel(state.mixDay)}`));
    if (mx.co2 != null) out.push(kpi('Emisiones', `${nf0.format(mx.co2 * 1000)}<small>g CO₂/kWh</small>`, dayLabel(state.mixDay)));
  }
  el.innerHTML = out.join('');
}

// Inserta cortes donde faltan datos (más de 5 minutos entre puntos) para no unirlos con rectas
function gaps(arr, step = 5) {
  const out = [];
  arr.forEach((d, i) => { if (i && d.m - arr[i - 1].m > step) out.push({ m: arr[i - 1].m + step, v: null }); out.push(d); });
  return out;
}

// ---------------- Gráfico principal ----------------
function renderMain() {
  const el = $('#mainChart');
  const t = state.rt?.today;
  if (!t) return placeholder(el, 'Cargando datos de Red Eléctrica…', true);
  if (!t.prevista.length && !t.real.length) return placeholder(el, 'No hay datos para este día.');
  const { svg, w, h } = svgIn(el);
  const mob = w < 600;
  const c = rtCalc();
  const M = { t: 12, r: mob ? 10 : 118, b: 26, l: 30 };
  const x = d3.scaleLinear([0, 1440], [M.l, w - M.r]);
  const S = state.show;
  const yday = S.yday ? state.rt.yday?.real || [] : [];
  const week = S.week ? state.rt.week?.real || [] : [];
  const prog = S.prog ? t.programada : [];
  const all = [...t.real, ...t.prevista, ...yday, ...week, ...prog].map(d => d.v);
  const y = d3.scaleLinear([d3.min(all) * 0.985, d3.max(all) * 1.01], [h - M.b, M.t]).nice();

  // Tramos tarifarios
  if (S.tariff) {
    const col = { 1: 'var(--t1)', 2: 'var(--t2)', 3: 'var(--t3)' };
    svg.append('g').selectAll('rect').data(tariffBands(state.date)).join('rect')
      .attr('x', d => x(d[0])).attr('width', d => x(d[1]) - x(d[0]))
      .attr('y', M.t).attr('height', h - M.b - M.t).style('fill', d => col[d[2]]);
  }

  // Rejilla y ejes
  const yt = y.ticks(mob ? 4 : 5);
  const g = svg.append('g').attr('class', 'grid');
  g.selectAll('line').data(yt).join('line').attr('x1', M.l).attr('x2', w - M.r + (mob ? 0 : 10)).attr('y1', y).attr('y2', y);
  svg.append('g').attr('class', 'axis').selectAll('text').data(yt).join('text')
    .attr('x', M.l - 6).attr('y', d => y(d) + 4).attr('text-anchor', 'end').text(d => nf0.format(d / 1000));
  const xt = mob ? [0, 360, 720, 1080, 1440] : d3.range(0, 1441, 180);
  svg.append('g').attr('class', 'axis').selectAll('text').data(xt).join('text')
    .attr('x', x).attr('y', h - 6).attr('text-anchor', (d, i) => (i === 0 ? 'start' : i === xt.length - 1 ? 'end' : 'middle'))
    .text(d => `${d / 60} h`);

  const line = d3.line().defined(d => d.v != null).x(d => x(d.m)).y(d => y(d.v)).curve(d3.curveMonotoneX);

  // Comparativas en gris
  if (week.length) svg.append('path').datum(gaps(week)).attr('d', line).style('fill', 'none').style('stroke', 'var(--g2)').style('stroke-width', 1.6).style('stroke-dasharray', '2 3');
  if (yday.length) svg.append('path').datum(gaps(yday)).attr('d', line).style('fill', 'none').style('stroke', 'var(--g1)').style('stroke-width', 1.6);

  // Área entre real y prevista
  if (c && c.paired.length > 1) {
    const area = d3.area().x(d => x(d.m)).y0(d => y(c.prev.get(d.m))).y1(d => y(d.v)).curve(d3.curveMonotoneX);
    svg.append('path').datum(c.paired).attr('d', area).style('fill', 'var(--prev-soft)');
    const lastP = c.paired[c.paired.length - 1];
    svg.append('line').attr('x1', x(lastP.m)).attr('x2', x(lastP.m)).attr('y1', y(lastP.v)).attr('y2', y(c.prev.get(lastP.m)))
      .style('stroke', 'var(--prev)').style('stroke-opacity', .5);
  }
  if (prog.length) svg.append('path').datum(gaps(prog)).attr('d', line).style('fill', 'none').style('stroke', 'var(--prog)').style('stroke-width', 1.8).style('stroke-dasharray', '6 4');
  svg.append('path').datum(gaps(t.prevista)).attr('d', line).style('fill', 'none').style('stroke', 'var(--prev)').style('stroke-width', mob ? 2.6 : 3.2).style('stroke-linejoin', 'round');
  if (t.real.length) svg.append('path').datum(gaps(t.real)).attr('d', d3.line().defined(d => d.v != null).x(d => x(d.m)).y(d => y(d.v))).style('fill', 'none').style('stroke', 'var(--real)').style('stroke-width', mob ? 2.6 : 3.2).style('stroke-linejoin', 'round');

  // Marca de "ahora"
  if (isToday()) {
    const nm = madridNow().minute;
    svg.append('line').attr('x1', x(nm)).attr('x2', x(nm)).attr('y1', M.t).attr('y2', h - M.b)
      .style('stroke', 'var(--ink-3)').style('stroke-dasharray', '1 3');
    svg.append('text').attr('class', 'lbl').attr('x', x(nm) + 4).attr('y', M.t + 10).text('ahora');
  }

  // Punto final y etiqueta
  if (c) {
    const lx = x(c.last.m), ly = y(c.last.v);
    svg.append('circle').attr('cx', lx).attr('cy', ly).attr('r', 6).style('fill', 'var(--real)').style('stroke', 'var(--card)').style('stroke-width', 2);
    if (c.hourDev != null) {
      const room = w - lx;
      const right = room > 112;
      const g2 = svg.append('g').attr('transform', `translate(${right ? lx + 12 : lx - 12},${right ? ly + 8 : ly + 34})`).attr('text-anchor', right ? 'start' : 'end');
      g2.append('text').text(pct(c.hourDev)).style('fill', 'var(--ink)').style('font-weight', 800).style('font-size', mob ? '20px' : '26px')
        .style('paint-order', 'stroke').style('stroke', 'var(--card)').style('stroke-width', 5);
      g2.append('text').attr('y', mob ? 18 : 22).text('en la última hora').style('fill', 'var(--ink-2)').style('font-size', mob ? '12px' : '14px')
        .style('paint-order', 'stroke').style('stroke', 'var(--card)').style('stroke-width', 4);
    }
  }

  // Interacción (ratón y táctil)
  const maps = {
    real: new Map(t.real.map(d => [d.m, d.v])), prev: new Map(t.prevista.map(d => [d.m, d.v])),
    prog: new Map(t.programada.map(d => [d.m, d.v])),
    yday: new Map((state.rt.yday?.real || []).map(d => [d.m, d.v])), week: new Map((state.rt.week?.real || []).map(d => [d.m, d.v])),
  };
  const focus = svg.append('g').style('display', 'none').style('pointer-events', 'none');
  const fl = focus.append('line').attr('y1', M.t).attr('y2', h - M.b).style('stroke', 'var(--ink-3)');
  const dots = ['real', 'prev'].map(k => focus.append('circle').attr('r', 4.5).style('fill', k === 'real' ? 'var(--real)' : 'var(--prev)').style('stroke', 'var(--card)').style('stroke-width', 2));
  svg.append('rect').attr('x', M.l).attr('y', M.t).attr('width', w - M.l - M.r).attr('height', h - M.t - M.b).style('fill', 'transparent')
    .on('pointermove pointerdown', ev => {
      const [px] = d3.pointer(ev);
      const m = Math.max(0, Math.min(1435, Math.round(x.invert(px) / 5) * 5));
      focus.style('display', null);
      fl.attr('x1', x(m)).attr('x2', x(m));
      [['real', dots[0]], ['prev', dots[1]]].forEach(([k, dot]) => {
        const v = maps[k].get(m);
        dot.style('display', v == null ? 'none' : null).attr('cx', x(m)).attr('cy', v == null ? 0 : y(v));
      });
      const r = maps.real.get(m), p = maps.prev.get(m);
      let html = `<div class="tt-h">${hm(m)} h</div>`;
      if (r != null) html += ttRow('Real', `${nf0.format(r)} MW`, css('--real'));
      if (p != null) html += ttRow('Prevista', `${nf0.format(p)} MW`, css('--prev'));
      if (r != null && p != null) html += ttRow('Desviación', `<span class="${cls(r - p)}">${signed(r - p, nf0)} MW (${pct((r / p - 1) * 100)})</span>`);
      if (S.prog && maps.prog.has(m)) html += ttRow('Programada', `${nf0.format(maps.prog.get(m))} MW`, css('--prog'), true);
      if (maps.yday.has(m)) html += ttRow('Ayer', `${nf0.format(maps.yday.get(m))} MW`, css('--g1'));
      if (maps.week.has(m)) html += ttRow('Hace 7 días', `${nf0.format(maps.week.get(m))} MW`, css('--g2'), true);
      tip.show(html, ev);
    })
    .on('pointerleave pointercancel', () => { focus.style('display', 'none'); tip.hide(); });
}

// ---------------- Desviación ----------------
function renderDev() {
  const el = $('#devChart');
  const c = rtCalc();
  if (!state.rt) return placeholder(el, 'Cargando…', true);
  if (!c || !c.devs.length) { $('#devStats').innerHTML = ''; return placeholder(el, 'Sin datos reales todavía.'); }
  const { svg, w, h } = svgIn(el);
  const M = { t: 10, r: 8, b: 24, l: 46 };
  const x = d3.scaleLinear([0, 1440], [M.l, w - M.r]);
  const ext = d3.max(c.devs, d => Math.abs(d.d)) || 1;
  const y = d3.scaleLinear([-ext, ext], [h - M.b, M.t]).nice();
  const yt = y.ticks(4);
  svg.append('g').attr('class', 'grid').selectAll('line').data(yt).join('line').attr('x1', M.l).attr('x2', w - M.r).attr('y1', y).attr('y2', y);
  svg.append('g').attr('class', 'axis').selectAll('text').data(yt).join('text').attr('x', M.l - 6).attr('y', d => y(d) + 4).attr('text-anchor', 'end').text(d => signed(d, nf0).replace('+', ''));
  const xt = w < 500 ? [0, 360, 720, 1080, 1440] : d3.range(0, 1441, 180);
  svg.append('g').attr('class', 'axis').selectAll('text').data(xt).join('text').attr('x', x).attr('y', h - 6)
    .attr('text-anchor', (d, i) => (i === 0 ? 'start' : i === xt.length - 1 ? 'end' : 'middle')).text(d => `${d / 60} h`);
  const bw = Math.max(1, x(5) - x(0) - (w > 700 ? 0.6 : 0.2));
  svg.append('g').selectAll('rect').data(c.devs).join('rect')
    .attr('x', d => x(d.m)).attr('width', bw)
    .attr('y', d => y(Math.max(0, d.d))).attr('height', d => Math.abs(y(d.d) - y(0)))
    .style('fill', d => (d.d >= 0 ? 'var(--up)' : 'var(--down)')).style('opacity', .85);
  svg.append('line').attr('class', 'zero').attr('x1', M.l).attr('x2', w - M.r).attr('y1', y(0)).attr('y2', y(0));
  const hl = svg.append('line').attr('y1', M.t).attr('y2', h - M.b).style('stroke', 'var(--ink-3)').style('display', 'none').style('pointer-events', 'none');
  const dm = new Map(c.devs.map(d => [d.m, d]));
  svg.append('rect').attr('x', M.l).attr('y', M.t).attr('width', w - M.l - M.r).attr('height', h - M.t - M.b).style('fill', 'transparent')
    .on('pointermove pointerdown', ev => {
      const m = Math.max(0, Math.min(1435, Math.round(x.invert(d3.pointer(ev)[0]) / 5) * 5));
      const d = dm.get(m);
      if (!d) return tip.hide();
      hl.style('display', null).attr('x1', x(m) + bw / 2).attr('x2', x(m) + bw / 2);
      tip.show(`<div class="tt-h">${hm(m)} h</div>${ttRow('Desviación', `<span class="${cls(d.d)}">${signed(d.d, nf0)} MW</span>`)}${ttRow('Sobre previsto', pct(d.d / d.p * 100))}`, ev);
    })
    .on('pointerleave pointercancel', () => { hl.style('display', 'none'); tip.hide(); });

  const mean = d3.mean(c.devs, d => d.d);
  const mape = d3.mean(c.devs, d => Math.abs(d.d) / d.p) * 100;
  const hi = d3.greatest(c.devs, d => d.d), lo = d3.least(c.devs, d => d.d);
  $('#devStats').innerHTML = [
    `<div class="ms"><span>Desviación media</span><b class="${cls(mean)}">${signed(mean, nf0)}</b><em>MW</em></div>`,
    `<div class="ms"><span>Error medio de la previsión</span><b>${nf1.format(mape)} %</b></div>`,
    `<div class="ms"><span>Mayor exceso</span><b class="up">${signed(hi.d, nf0)}</b><em>${hm(hi.m)}</em></div>`,
    `<div class="ms"><span>Mayor defecto</span><b class="down">${signed(lo.d, nf0)}</b><em>${hm(lo.m)}</em></div>`,
  ].join('');
}

// ---------------- Precios ----------------
function renderPrices() {
  const el = $('#priceChart');
  const p = state.prices;
  if (!p) return placeholder(el, 'Cargando precios…', true);
  if (!p.pvpc.length && !p.spot.length) { $('#priceStats').innerHTML = ''; return placeholder(el, 'No hay precios publicados para este día.'); }
  const { svg, w, h } = svgIn(el);
  const M = { t: 10, r: 8, b: 24, l: 40 };
  const x = d3.scaleLinear([0, 1440], [M.l, w - M.r]);
  const all = [...p.pvpc, ...p.spot].map(d => d.v);
  const y = d3.scaleLinear([Math.min(0, d3.min(all)), d3.max(all) * 1.06], [h - M.b, M.t]).nice();
  const yt = y.ticks(4);
  svg.append('g').attr('class', 'grid').selectAll('line').data(yt).join('line').attr('x1', M.l).attr('x2', w - M.r).attr('y1', y).attr('y2', y);
  svg.append('g').attr('class', 'axis').selectAll('text').data(yt).join('text').attr('x', M.l - 6).attr('y', d => y(d) + 4).attr('text-anchor', 'end').text(d => nf0.format(d));
  const xt = w < 500 ? [0, 360, 720, 1080, 1440] : d3.range(0, 1441, 180);
  svg.append('g').attr('class', 'axis').selectAll('text').data(xt).join('text').attr('x', x).attr('y', h - 6)
    .attr('text-anchor', (d, i) => (i === 0 ? 'start' : i === xt.length - 1 ? 'end' : 'middle')).text(d => `${d / 60} h`);
  const pv = p.pvpc;
  const color = d3.scaleSequential(d3.extent(pv, d => d.v), d3.interpolateRgbBasis([css('--up'), '#e9c24a', css('--down')]));
  const bw = x(60) - x(0);
  svg.append('g').selectAll('rect').data(pv).join('rect')
    .attr('x', d => x(d.m) + 1).attr('width', Math.max(1, bw - 2)).attr('y', d => y(Math.max(0, d.v))).attr('height', d => Math.abs(y(d.v) - y(0)))
    .attr('rx', 2).style('fill', d => color(d.v)).style('opacity', .55);
  if (p.spot.length) {
    const step = [...p.spot, { m: p.spot[p.spot.length - 1].m + 15, v: p.spot[p.spot.length - 1].v }];
    svg.append('path').datum(step).attr('d', d3.line().x(d => x(d.m)).y(d => y(d.v)).curve(d3.curveStepAfter))
      .style('fill', 'none').style('stroke', 'var(--real)').style('stroke-width', 2);
  }
  if (isToday()) {
    const nm = madridNow().minute;
    svg.append('line').attr('x1', x(nm)).attr('x2', x(nm)).attr('y1', M.t).attr('y2', h - M.b).style('stroke', 'var(--ink-3)').style('stroke-dasharray', '1 3');
  }
  const hl = svg.append('rect').attr('y', M.t).attr('height', h - M.t - M.b).attr('width', bw).style('fill', 'var(--ink)').style('opacity', .06).style('display', 'none').style('pointer-events', 'none');
  svg.append('rect').attr('x', M.l).attr('y', M.t).attr('width', w - M.l - M.r).attr('height', h - M.t - M.b).style('fill', 'transparent')
    .on('pointermove pointerdown', ev => {
      const mm = Math.max(0, Math.min(1439, x.invert(d3.pointer(ev)[0])));
      const hr = Math.floor(mm / 60) * 60, q = Math.floor(mm / 15) * 15;
      const a = pv.find(d => d.m === hr), s = p.spot.find(d => d.m === q);
      hl.style('display', null).attr('x', x(hr));
      let html = `<div class="tt-h">${hm(hr)}–${hm(hr + 60)} h</div>`;
      if (a) html += ttRow('PVPC', `${nf2.format(a.v)} €/MWh`, color(a.v)) + ttRow('', `${nf3.format(a.v / 1000)} €/kWh`);
      if (s) html += ttRow(`Mayorista ${hm(q)}`, `${nf2.format(s.v)} €/MWh`, css('--real'));
      tip.show(html, ev);
    })
    .on('pointerleave pointercancel', () => { hl.style('display', 'none'); tip.hide(); });

  const st = [];
  if (pv.length) {
    const lo = d3.least(pv, d => d.v), hi = d3.greatest(pv, d => d.v);
    st.push(`<div class="ms"><span>PVPC medio</span><b>${nf3.format(d3.mean(pv, d => d.v) / 1000)}</b><em>€/kWh</em></div>`);
    st.push(`<div class="ms"><span>Hora más barata</span><b class="up">${hm(lo.m)}</b><em>${nf3.format(lo.v / 1000)} €/kWh</em></div>`);
    st.push(`<div class="ms"><span>Hora más cara</span><b class="down">${hm(hi.m)}</b><em>${nf3.format(hi.v / 1000)} €/kWh</em></div>`);
  }
  if (p.spot.length) st.push(`<div class="ms"><span>Mayorista medio</span><b>${nf1.format(d3.mean(p.spot, d => d.v))}</b><em>€/MWh</em></div>`);
  $('#priceStats').innerHTML = st.join('');
}

// ---------------- Mix de generación ----------------
const dayLabel = d => {
  const today = madridNow().date;
  if (d === today) return 'hoy (provisional)';
  if (d === addDays(today, -1)) return 'ayer';
  return fmtDay(d, { weekday: 'short', day: 'numeric', month: 'short' });
};
function mixDays() {
  return state.mix ? [...new Set(state.mix.total.map(x => x.d))].sort() : [];
}
function mixDayStats(day) {
  if (!state.mix || !day) return null;
  const items = state.mix.techs.map(t => ({ title: t.title, type: t.type, color: t.color, v: t.values.find(x => x.d === day)?.v || 0 }))
    .filter(t => t.v > 0);
  const total = d3.sum(items, t => t.v);
  if (!total) return null;
  const ren = d3.sum(items.filter(t => t.type === 'Renovable'), t => t.v);
  const co2 = state.mix.co2.find(x => x.d === day)?.v ?? null;
  return { items, total, renShare: ren / total * 100, co2 };
}
function renderMixChips() {
  const days = mixDays().slice(-7);
  $('#mixDays').innerHTML = days.map(d => `<button class="chip ${d === state.mixDay ? 'on' : ''}" data-d="${d}">${cap(dayLabel(d))}</button>`).join('');
}
function renderMix() {
  const el = $('#mixDonut');
  if (!state.mix) { $('#mixList').innerHTML = ''; return placeholder(el, 'Cargando…', true); }
  const st = mixDayStats(state.mixDay);
  if (!st) return placeholder(el, 'Sin datos de generación.');
  $('#mixDayLbl').textContent = `${cap(fmtDay(state.mixDay))}, en GWh.${state.mixDay === madridNow().date ? ' Datos del día en curso, provisionales.' : ''}`;
  const { svg, w, h } = svgIn(el);
  const R = Math.min(w, h) / 2 - 4;
  const order = [...st.items].sort((a, b) => (a.type === b.type ? b.v - a.v : a.type === 'Renovable' ? -1 : 1));
  const pie = d3.pie().value(d => d.v).sort(null).padAngle(0.012);
  const arc = d3.arc().innerRadius(R * 0.62).outerRadius(R).cornerRadius(3);
  const g = svg.append('g').attr('transform', `translate(${w / 2},${h / 2})`);
  g.selectAll('path').data(pie(order)).join('path').attr('d', arc).style('fill', d => d.data.color)
    .on('pointermove pointerdown', (ev, d) => tip.show(`<div class="tt-h">${d.data.title}</div>${ttRow('Generación', `${nf1.format(d.data.v / 1000)} GWh`)}${ttRow('Peso', `${nf1.format(d.data.v / st.total * 100)} %`)}${ttRow('Tipo', d.data.type)}`, ev))
    .on('pointerleave', () => tip.hide());
  g.append('text').attr('text-anchor', 'middle').attr('y', 4).style('font-size', `${Math.max(20, R * 0.3)}px`).style('font-weight', 800).style('fill', 'var(--ink)').text(`${nf0.format(st.renShare)} %`);
  g.append('text').attr('text-anchor', 'middle').attr('y', 4 + Math.max(16, R * 0.2)).style('font-size', '12px').style('fill', 'var(--ink-2)').text('renovable');
  const grp = (name, list) => list.length ? `<li class="grp"><span>${name}</span><span>${nf1.format(d3.sum(list, t => t.v) / st.total * 100)} %</span></li>` +
    list.map(t => `<li><i style="background:${t.color}"></i><span>${t.title}</span><span>${nf1.format(t.v / 1000)} GWh</span><b>${nf1.format(t.v / st.total * 100)} %</b></li>`).join('') : '';
  $('#mixList').innerHTML = grp('Renovable', order.filter(t => t.type === 'Renovable')) + grp('No renovable', order.filter(t => t.type !== 'Renovable')) +
    `<li class="grp"><span>Total generado</span><span>${nf1.format(st.total / 1000)} GWh</span></li>`;
}
function renderMixBars() {
  const el = $('#mixBars'), el2 = $('#co2Chart');
  if (!state.mix) { placeholder(el2, ''); return placeholder(el, 'Cargando…', true); }
  const days = mixDays();
  if (!days.length) return placeholder(el, 'Sin datos.');
  const techs = [...state.mix.techs].filter(t => d3.sum(t.values, x => Math.max(0, x.v)) > 0)
    .sort((a, b) => (a.type === b.type ? d3.sum(b.values, x => x.v) - d3.sum(a.values, x => x.v) : a.type === 'Renovable' ? -1 : 1));
  const rows = days.map(d => {
    const r = { d };
    let tot = 0;
    for (const t of techs) { const v = Math.max(0, t.values.find(x => x.d === d)?.v || 0); r[t.title] = v; tot += v; }
    for (const t of techs) r[t.title] = tot ? r[t.title] / tot : 0;
    r._ren = d3.sum(techs.filter(t => t.type === 'Renovable'), t => r[t.title]);
    return r;
  });
  const stack = d3.stack().keys(techs.map(t => t.title))(rows);
  const { svg, w, h } = svgIn(el);
  const M = { t: 6, r: 6, b: 22, l: 34 };
  const x = d3.scaleBand(days, [M.l, w - M.r]).padding(0.12);
  const y = d3.scaleLinear([0, 1], [h - M.b, M.t]);
  svg.append('g').selectAll('g').data(stack).join('g').style('fill', (d, i) => techs[i].color)
    .selectAll('rect').data(d => d).join('rect').attr('x', d => x(d.data.d)).attr('width', x.bandwidth())
    .attr('y', d => y(d[1])).attr('height', d => Math.max(0, y(d[0]) - y(d[1])));
  // Línea de cuota renovable
  svg.append('path').datum(rows).attr('d', d3.line().x(d => x(d.d) + x.bandwidth() / 2).y(d => y(d._ren)).curve(d3.curveMonotoneX))
    .style('fill', 'none').style('stroke', 'var(--card)').style('stroke-width', 3.5);
  svg.append('path').datum(rows).attr('d', d3.line().x(d => x(d.d) + x.bandwidth() / 2).y(d => y(d._ren)).curve(d3.curveMonotoneX))
    .style('fill', 'none').style('stroke', 'var(--real)').style('stroke-width', 1.6).style('stroke-dasharray', '4 3');
  svg.append('g').attr('class', 'axis').selectAll('text').data([0, .5, 1]).join('text').attr('x', M.l - 6).attr('y', d => y(d) + 4).attr('text-anchor', 'end').text(d => `${d * 100} %`);
  const every = Math.ceil(days.length / (w < 500 ? 4 : 7));
  svg.append('g').attr('class', 'axis').selectAll('text').data(days.filter((d, i) => (days.length - 1 - i) % every === 0)).join('text')
    .attr('x', d => x(d) + x.bandwidth() / 2).attr('y', h - 6).attr('text-anchor', 'middle').text(d => fmtDay(d, { day: 'numeric', month: 'short' }));
  svg.append('g').selectAll('rect').data(rows).join('rect').attr('x', d => x(d.d)).attr('width', x.bandwidth()).attr('y', M.t).attr('height', h - M.t - M.b)
    .style('fill', 'transparent')
    .on('pointermove pointerdown', (ev, r) => {
      const top = techs.map(t => ({ t, v: r[t.title] })).sort((a, b) => b.v - a.v).slice(0, 5);
      tip.show(`<div class="tt-h">${cap(fmtDay(r.d, { weekday: 'short', day: 'numeric', month: 'short' }))}</div>${ttRow('Renovable', `${nf1.format(r._ren * 100)} %`)}` +
        top.map(o => ttRow(o.t.title, `${nf1.format(o.v * 100)} %`, o.t.color)).join(''), ev);
    })
    .on('pointerleave', () => tip.hide());

  // CO2
  const co2 = state.mix.co2.filter(x => days.includes(x.d));
  if (!co2.length) return placeholder(el2, 'Sin datos de emisiones.');
  const s2 = svgIn(el2);
  const y2 = d3.scaleLinear([0, d3.max(co2, d => d.v) * 1000 * 1.15], [s2.h - 18, 14]).nice();
  const xc = d => x(d) + x.bandwidth() / 2;
  s2.svg.append('g').attr('class', 'grid').selectAll('line').data(y2.ticks(2)).join('line').attr('x1', M.l).attr('x2', s2.w - M.r).attr('y1', y2).attr('y2', y2);
  s2.svg.append('g').attr('class', 'axis').selectAll('text').data(y2.ticks(2)).join('text').attr('x', M.l - 6).attr('y', d => y2(d) + 4).attr('text-anchor', 'end').text(d => nf0.format(d));
  s2.svg.append('path').datum(co2).attr('d', d3.area().x(d => xc(d.d)).y0(y2(0)).y1(d => y2(d.v * 1000)).curve(d3.curveMonotoneX)).style('fill', 'var(--ink-3)').style('opacity', .15);
  s2.svg.append('path').datum(co2).attr('d', d3.line().x(d => xc(d.d)).y(d => y2(d.v * 1000)).curve(d3.curveMonotoneX)).style('fill', 'none').style('stroke', 'var(--ink-2)').style('stroke-width', 2);
  s2.svg.append('text').attr('class', 'lbl').attr('x', M.l).attr('y', 10).text('g CO₂ eq./kWh');
  s2.svg.append('g').selectAll('circle').data(co2).join('circle').attr('cx', d => xc(d.d)).attr('cy', d => y2(d.v * 1000)).attr('r', 6).style('fill', 'transparent')
    .on('pointermove pointerdown', (ev, d) => {
      const tot = state.mix.co2total.find(x => x.d === d.d);
      tip.show(`<div class="tt-h">${cap(fmtDay(d.d, { weekday: 'short', day: 'numeric', month: 'short' }))}</div>${ttRow('Intensidad', `${nf0.format(d.v * 1000)} g/kWh`)}${tot ? ttRow('Total', `${nf0.format(tot.v)} t CO₂`) : ''}`, ev);
    })
    .on('pointerleave', () => tip.hide());
}

// ---------------- Sistemas eléctricos ----------------
function renderSystems() {
  const box = $('#systems');
  if (!state.systems) { box.innerHTML = '<div class="chart"><div class="loading">Cargando…</div></div>'; return; }
  const today = madridNow().date;
  if (!box.children.length || box.querySelector('.loading')) {
    box.innerHTML = state.systems.systems.map(s => `<div class="sys" data-k="${s.key}"><h3>${s.name}</h3><div class="s-val"></div><div class="s-sub"></div><div class="chart"></div></div>`).join('');
  }
  for (const s of state.systems.systems) {
    const card = box.querySelector(`[data-k="${s.key}"]`);
    const vals = s.values.filter(v => v.d < today);
    const unitBig = d3.max(vals, v => v.v) > 10000;
    const fmtV = v => unitBig ? `${nf1.format(v / 1000)}<small>GWh</small>` : `${nf0.format(v)}<small>MWh</small>`;
    const last = vals[vals.length - 1];
    if (!last) { card.querySelector('.s-sub').textContent = 'Sin datos'; continue; }
    const wk = vals.find(v => v.d === addDays(last.d, -7));
    const chg = wk ? (last.v / wk.v - 1) * 100 : null;
    card.querySelector('.s-val').innerHTML = fmtV(last.v);
    card.querySelector('.s-sub').innerHTML = `${dayLabel(last.d)}${chg != null ? ` · <span class="${cls(chg)}">${pct(chg)}</span> vs semana ant.` : ''}`;
    const el = card.querySelector('.chart');
    register(el, () => {
      const { svg, w, h } = svgIn(el);
      const x = d3.scaleTime(d3.extent(vals, v => dateObj(v.d)), [3, w - 3]);
      const y = d3.scaleLinear(d3.extent(vals, v => v.v), [h - 5, 5]);
      svg.append('path').datum(vals).attr('d', d3.area().x(v => x(dateObj(v.d))).y0(h).y1(v => y(v.v)).curve(d3.curveMonotoneX)).style('fill', 'var(--prev-soft)');
      svg.append('path').datum(vals).attr('d', d3.line().x(v => x(dateObj(v.d))).y(v => y(v.v)).curve(d3.curveMonotoneX)).style('fill', 'none').style('stroke', 'var(--real)').style('stroke-width', 1.5);
      svg.append('g').selectAll('circle').data(vals.filter(v => [0, 6].includes(dow(v.d)))).join('circle')
        .attr('cx', v => x(dateObj(v.d))).attr('cy', v => y(v.v)).attr('r', 1.8).style('fill', 'var(--prev)');
      const fh = svg.append('circle').attr('r', 3.5).style('fill', 'var(--real)').style('display', 'none');
      svg.append('rect').attr('width', w).attr('height', h).style('fill', 'transparent')
        .on('pointermove pointerdown', ev => {
          const t = x.invert(d3.pointer(ev)[0]);
          const v = d3.least(vals, v => Math.abs(dateObj(v.d) - t));
          fh.style('display', null).attr('cx', x(dateObj(v.d))).attr('cy', y(v.v));
          tip.show(`<div class="tt-h">${s.name}</div>${ttRow(cap(fmtDay(v.d, { weekday: 'short', day: 'numeric', month: 'short' })), unitBig ? `${nf1.format(v.v / 1000)} GWh` : `${nf0.format(v.v)} MWh`)}`, ev);
        })
        .on('pointerleave', () => { fh.style('display', 'none'); tip.hide(); });
    });
  }
}

// ---------------- Comunidades ----------------
const REG_METRICS = [
  { k: 'total', label: 'Generación total (GWh)' },
  { k: 'ren', label: '% renovable' },
  { k: 'Eólica', label: 'Eólica (GWh)' },
  { k: 'Solar fotovoltaica', label: 'Solar fotovoltaica (GWh)' },
  { k: 'Hidráulica', label: 'Hidráulica (GWh)' },
  { k: 'Nuclear', label: 'Nuclear (GWh)' },
  { k: 'Ciclo combinado', label: 'Ciclo combinado (GWh)' },
  { k: 'Cogeneración', label: 'Cogeneración (GWh)' },
];
let topo = null;
function regionAgg() {
  const by = new Map(); // ine → month → {total, ren, techs}
  const months = new Map();
  for (const r of state.regions.regions) {
    const mm = new Map();
    for (const t of r.techs) for (const v of t.values) {
      if (v.v <= 0) continue;
      const o = mm.get(v.m) || { total: 0, ren: 0, t: {} };
      o.total += v.v; if (t.group === 'Renovable') o.ren += v.v;
      o.t[t.title] = (o.t[t.title] || 0) + v.v;
      mm.set(v.m, o);
    }
    for (const m of mm.keys()) months.set(m, (months.get(m) || 0) + 1);
    by.set(r.ine, { name: r.name, mm });
  }
  const ms = [...months].filter(([, n]) => n >= 10).map(([m]) => m).sort().reverse();
  return { by, months: ms };
}
function metricValue(o, k) {
  if (!o) return null;
  if (k === 'total') return o.total / 1000;
  if (k === 'ren') return o.total ? o.ren / o.total * 100 : null;
  return (o.t[k] || 0) / 1000;
}
const fmtMetric = (v, k) => v == null ? '—' : k === 'ren' ? `${nf0.format(v)} %` : v >= 100 ? nf0.format(v) : nf1.format(v);
let regHl = null;
function renderRegions() {
  const mapEl = $('#regMap'), rank = $('#regRank');
  if (!state.regions) { rank.innerHTML = ''; return placeholder(mapEl, 'Cargando comunidades… (la primera carga tarda unos segundos)', true); }
  const agg = regionAgg();
  const mSel = $('#regMonth'), kSel = $('#regMetric');
  if (!mSel.options.length) {
    mSel.innerHTML = agg.months.map(m => `<option value="${m}">${cap(fmtMonth(m))}</option>`).join('');
    kSel.innerHTML = REG_METRICS.map(o => `<option value="${o.k}">${o.label}</option>`).join('');
  }
  const month = mSel.value, k = kSel.value;
  const rows = [...agg.by].map(([ine, r]) => ({ ine, name: r.name, v: metricValue(r.mm.get(month), k) }));
  const valid = rows.filter(r => r.v != null);
  const max = d3.max(valid, r => r.v) || 1;
  const interp = k === 'ren' ? d3.interpolateRgb(css('--grid') || '#eee', css('--up')) : d3.interpolateRgb('#fbe8cc', '#b4520a');
  const color = d3.scaleSequentialSqrt([0, k === 'ren' ? 100 : max], interp);
  const colorOf = r => (r && r.v != null ? color(r.v) : css('--grid'));
  const byIne = new Map(rows.map(r => [r.ine, r]));

  // Ranking
  const sorted = [...rows].sort((a, b) => (b.v ?? -1) - (a.v ?? -1));
  rank.innerHTML = sorted.map(r => `<div class="r" data-ine="${r.ine}"><span>${r.name}</span><div><div class="bar" style="width:${r.v == null ? 0 : (r.v / (k === 'ren' ? 100 : max)) * 100}%;background:${colorOf(r)}"></div></div><b>${fmtMetric(r.v, k)}</b></div>`).join('');
  rank.querySelectorAll('.r').forEach(n => {
    n.addEventListener('pointerenter', () => highlight(n.dataset.ine));
    n.addEventListener('pointerleave', () => highlight(null));
  });
  const unit = k === 'ren' ? '%' : 'GWh';
  $('#regLegend').innerHTML = `<span>0 ${unit}</span><span class="ramp" style="background:linear-gradient(90deg,${d3.range(0, 1.01, .1).map(t => color(t * (k === 'ren' ? 100 : max))).join(',')})"></span><span>${fmtMetric(k === 'ren' ? 100 : max, k)} ${unit}</span><span>· ${cap(fmtMonth(month))}</span>`;

  // Mapa
  if (!topo) {
    placeholder(mapEl, 'Cargando mapa…', true);
    d3.json('https://cdn.jsdelivr.net/npm/es-atlas@0.6.0/es/autonomous_regions.json').then(t => { topo = t; renderRegions(); })
      .catch(() => placeholder(mapEl, 'No se pudo cargar el mapa.'));
    return;
  }
  const { svg, w, h } = svgIn(mapEl);
  const fc = topojson.feature(topo, topo.objects.autonomous_regions);
  fc.features = fc.features.filter(f => f.id !== '20');
  const proj = d3.geoConicConformalSpain().fitSize([w, h], fc);
  const path = d3.geoPath(proj);
  svg.append('g').selectAll('path').data(fc.features).join('path').attr('class', 'reg').attr('d', path)
    .attr('data-ine', f => f.id).style('fill', f => colorOf(byIne.get(f.id)))
    .on('pointermove pointerdown', (ev, f) => {
      const r = byIne.get(f.id);
      const o = agg.by.get(f.id)?.mm.get(month);
      highlight(f.id);
      let html = `<div class="tt-h">${r?.name || f.properties.name}</div>`;
      if (o) {
        html += ttRow('Generación', `${nf0.format(o.total / 1000)} GWh`) + ttRow('Renovable', `${nf0.format(o.ren / o.total * 100)} %`);
        Object.entries(o.t).sort((a, b) => b[1] - a[1]).slice(0, 4).forEach(([t, v]) => { html += ttRow(t, `${nf0.format(v / 1000)} GWh`); });
      } else html += '<div>Sin datos este mes</div>';
      tip.show(html, ev);
    })
    .on('pointerleave', () => { highlight(null); tip.hide(); });
  svg.append('path').attr('class', 'comp').attr('d', proj.getCompositionBorders());
}
function highlight(ine) {
  regHl = ine;
  document.querySelectorAll('#regMap path.reg').forEach(p => p.classList.toggle('hl', p.dataset.ine === ine));
  document.querySelectorAll('#regRank .r').forEach(r => r.classList.toggle('hl', r.dataset.ine === ine));
}

// ---------------- IRE ----------------
function renderIRE() {
  const el = $('#ireChart');
  if (!state.ire) return placeholder(el, 'Cargando…', true);
  const sectors = [
    { k: 'general', label: 'General', color: 'var(--gen)' },
    { k: 'industria', label: 'Industria', color: 'var(--ind)' },
    { k: 'servicios', label: 'Servicios', color: 'var(--ser)' },
  ].map(s => ({ ...s, values: (state.ire[s.k] || []).find(x => x.title === 'Variación mensual corregida')?.values || [] }))
    .filter(s => s.values.length);
  if (!sectors.length) { $('#ireStats').innerHTML = ''; return placeholder(el, 'Índice no disponible en este momento.'); }
  $('#ireStats').innerHTML = sectors.map(s => {
    const l = s.values[s.values.length - 1];
    return `<div class="ms"><span>${s.label} · ${fmtMonth(l.m, { month: 'short', year: 'numeric' })}</span><b class="${cls(l.v)}">${pct(l.v)}</b></div>`;
  }).join('');
  const { svg, w, h } = svgIn(el);
  const M = { t: 10, r: 10, b: 24, l: 40 };
  const all = sectors.flatMap(s => s.values);
  const pm = m => new Date(m + '-15T12:00:00Z');
  const x = d3.scaleTime(d3.extent(all, d => pm(d.m)), [M.l, w - M.r]);
  const ext = d3.max(all, d => Math.abs(d.v)) || 1;
  const y = d3.scaleLinear([-ext, ext], [h - M.b, M.t]).nice();
  svg.append('g').attr('class', 'grid').selectAll('line').data(y.ticks(5)).join('line').attr('x1', M.l).attr('x2', w - M.r).attr('y1', y).attr('y2', y);
  svg.append('g').attr('class', 'axis').selectAll('text').data(y.ticks(5)).join('text').attr('x', M.l - 6).attr('y', d => y(d) + 4).attr('text-anchor', 'end').text(d => `${signed(d, nf0).replace('+', '')}%`);
  svg.append('g').attr('class', 'axis').selectAll('text').data(x.ticks(w < 500 ? 4 : 7)).join('text').attr('x', x).attr('y', h - 6).attr('text-anchor', 'middle')
    .text(d => new Intl.DateTimeFormat('es-ES', { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(d));
  svg.append('line').attr('class', 'zero').attr('x1', M.l).attr('x2', w - M.r).attr('y1', y(0)).attr('y2', y(0));
  for (const s of sectors) {
    svg.append('path').datum(s.values).attr('d', d3.line().x(d => x(pm(d.m))).y(d => y(d.v)).curve(d3.curveMonotoneX))
      .style('fill', 'none').style('stroke', s.color).style('stroke-width', s.k === 'general' ? 2.6 : 1.8);
  }
  const months = [...new Set(all.map(d => d.m))].sort();
  const hl = svg.append('line').attr('y1', M.t).attr('y2', h - M.b).style('stroke', 'var(--ink-3)').style('display', 'none').style('pointer-events', 'none');
  svg.append('rect').attr('x', M.l).attr('y', M.t).attr('width', w - M.l - M.r).attr('height', h - M.t - M.b).style('fill', 'transparent')
    .on('pointermove pointerdown', ev => {
      const t = x.invert(d3.pointer(ev)[0]);
      const m = d3.least(months, mm => Math.abs(pm(mm) - t));
      hl.style('display', null).attr('x1', x(pm(m))).attr('x2', x(pm(m)));
      tip.show(`<div class="tt-h">${cap(fmtMonth(m))}</div>` + sectors.map(s => {
        const v = s.values.find(d => d.m === m);
        return v ? ttRow(s.label, `<span class="${cls(v.v)}">${pct(v.v)}</span>`, css(s.color.slice(4, -1))) : '';
      }).join(''), ev);
    })
    .on('pointerleave', () => { hl.style('display', 'none'); tip.hide(); });
}

// ---------------- Tendencia nacional ----------------
function renderNational() {
  const el = $('#natChart');
  if (!state.national) return placeholder(el, 'Cargando…', true);
  const today = madridNow().date;
  const vals = state.national.values.filter(v => v.d < today);
  const map = new Map(vals.map(v => [v.d, v.v]));
  const ma = d => {
    const a = []; for (let i = 0; i < 7; i++) { const v = map.get(addDays(d, -i)); if (v != null) a.push(v); }
    return a.length >= 5 ? d3.mean(a) : null;
  };
  const start = addDays(today, -365);
  const days = vals.filter(v => v.d >= start).map(v => v.d);
  const cur = days.map(d => ({ d, v: ma(d) })).filter(x => x.v != null);
  const prev = days.map(d => ({ d, v: ma(addDays(d, -364)) })).filter(x => x.v != null);
  // Compara solo días con dato en ambos años (mismo día de la semana: 364 días antes)
  const y1 = addDays(today, -1);
  const pair = n => {
    let a = 0, b = 0;
    for (let i = 1; i <= n; i++) {
      const d = addDays(today, -i), v = map.get(d), p = map.get(addDays(d, -364));
      if (v != null && p != null) { a += v; b += p; }
    }
    return [a, b];
  };
  const [l30, p30] = pair(30), [l365, p365] = pair(364);
  $('#natStats').innerHTML = [
    map.has(y1) ? `<div class="ms"><span>Ayer</span><b>${nf1.format(map.get(y1) / 1000)}</b><em>GWh</em></div>` : '',
    p30 ? `<div class="ms"><span>Últimos 30 días vs año ant.</span><b class="${cls(l30 / p30 - 1)}">${pct((l30 / p30 - 1) * 100)}</b></div>` : '',
    p365 ? `<div class="ms"><span>Últimas 52 semanas</span><b>${nf1.format(l365 / 1e6)}</b><em>TWh ·<span class="${cls(l365 / p365 - 1)}">${pct((l365 / p365 - 1) * 100)}</span></em></div>` : '',
  ].join('');
  if (!cur.length) return placeholder(el, 'Sin datos.');
  const { svg, w, h } = svgIn(el);
  const M = { t: 10, r: 10, b: 24, l: 40 };
  const x = d3.scaleTime(d3.extent(cur, d => dateObj(d.d)), [M.l, w - M.r]);
  const ally = [...cur, ...prev].map(d => d.v / 1000);
  const y = d3.scaleLinear([d3.min(ally) * 0.97, d3.max(ally) * 1.02], [h - M.b, M.t]).nice();
  svg.append('g').attr('class', 'grid').selectAll('line').data(y.ticks(4)).join('line').attr('x1', M.l).attr('x2', w - M.r).attr('y1', y).attr('y2', y);
  svg.append('g').attr('class', 'axis').selectAll('text').data(y.ticks(4)).join('text').attr('x', M.l - 6).attr('y', d => y(d) + 4).attr('text-anchor', 'end').text(d => nf0.format(d));
  svg.append('g').attr('class', 'axis').selectAll('text').data(x.ticks(w < 500 ? 4 : 8)).join('text').attr('x', x).attr('y', h - 6).attr('text-anchor', 'middle')
    .text(d => new Intl.DateTimeFormat('es-ES', { month: 'short', timeZone: 'UTC' }).format(d));
  const line = d3.line().x(d => x(dateObj(d.d))).y(d => y(d.v / 1000)).curve(d3.curveMonotoneX);
  svg.append('path').datum(prev).attr('d', line).style('fill', 'none').style('stroke', 'var(--g1)').style('stroke-width', 1.8);
  svg.append('path').datum(cur).attr('d', line).style('fill', 'none').style('stroke', 'var(--real)').style('stroke-width', 2.4);
  const pm = new Map(prev.map(d => [d.d, d.v])), cm = new Map(cur.map(d => [d.d, d.v]));
  const hl = svg.append('line').attr('y1', M.t).attr('y2', h - M.b).style('stroke', 'var(--ink-3)').style('display', 'none').style('pointer-events', 'none');
  svg.append('rect').attr('x', M.l).attr('y', M.t).attr('width', w - M.l - M.r).attr('height', h - M.t - M.b).style('fill', 'transparent')
    .on('pointermove pointerdown', ev => {
      const t = x.invert(d3.pointer(ev)[0]);
      const d = d3.least(cur, c => Math.abs(dateObj(c.d) - t)).d;
      hl.style('display', null).attr('x1', x(dateObj(d))).attr('x2', x(dateObj(d)));
      const c = cm.get(d), p = pm.get(d);
      tip.show(`<div class="tt-h">${cap(fmtDay(d, { day: 'numeric', month: 'short', year: 'numeric' }))}</div>${ttRow('Día', map.has(d) ? `${nf1.format(map.get(d) / 1000)} GWh` : '—')}${ttRow('Media 7 días', `${nf1.format(c / 1000)} GWh`, css('--real'))}${p ? ttRow('Año anterior', `${nf1.format(p / 1000)} GWh`, css('--g1')) + ttRow('Variación', `<span class="${cls(c - p)}">${pct((c / p - 1) * 100)}</span>`) : ''}`, ev);
    })
    .on('pointerleave', () => { hl.style('display', 'none'); tip.hide(); });
}

// ---------------- Estado y cabecera ----------------
function renderStatus() {
  const st = $('#status'), txt = $('#statusText');
  const tag = $('#liveTag');
  const c = rtCalc();
  const today = isToday();
  tag.classList.toggle('hist', !today);
  tag.querySelector('b').textContent = today ? 'En directo' : 'Histórico';
  $('#liveTime').textContent = c ? (today ? ` · dato de las ${hShort(c.last.m)}` : ` · ${fmtDay(state.date, { weekday: 'short', day: 'numeric', month: 'short' })}`) : '';
  $('#dayDelta').textContent = c?.dayDev != null ? pct(c.dayDev) : '—';
  st.classList.remove('live', 'err');
  if (state.error && !state.rt) { st.classList.add('err'); txt.textContent = 'Sin conexión con Red Eléctrica'; return; }
  if (!c) { txt.textContent = 'Conectando…'; return; }
  if (!today) { txt.textContent = `Histórico · ${fmtDay(state.date, { day: 'numeric', month: 'short', year: 'numeric' })}`; return; }
  st.classList.add('live');
  const age = Math.max(0, madridNow().minute - c.last.m);
  const nxt = state.refresh ? Math.max(0, Math.round((state.nextAt - Date.now()) / 1000)) : null;
  txt.textContent = `Dato ${hShort(c.last.m)} · hace ${age} min${nxt != null ? ` · consulta en ${nxt} s` : ' · en pausa'}${state.error ? ' · reintentando' : ''}`;
}

// ---------------- Carga de datos ----------------
async function loadRealtime() {
  const d = state.date;
  try {
    const [t, y, w] = await Promise.allSettled([
      getJSON(`/api/realtime?date=${d}`), getJSON(`/api/realtime?date=${addDays(d, -1)}`), getJSON(`/api/realtime?date=${addDays(d, -7)}`),
    ]);
    if (d !== state.date) return;
    if (t.status !== 'fulfilled') throw t.reason;
    state.rt = { today: t.value, yday: y.value || null, week: w.value || null };
    state.error = null;
    $('#lblYday').textContent = `el ${fmtDay(addDays(d, -1), { weekday: 'long', day: 'numeric' })}`;
    $('#lblWeek').textContent = `el ${fmtDay(addDays(d, -7), { weekday: 'long', day: 'numeric' })}`;
  } catch (e) { state.error = e.message; }
  renderKPIs(); renderMain(); renderDev(); renderStatus();
}
async function loadPrices() {
  try { state.prices = await getJSON(`/api/prices?date=${state.date}`); } catch { state.prices = { pvpc: [], spot: [] }; }
  renderPrices(); renderKPIs();
}
async function loadMix() {
  try {
    state.mix = await getJSON(`/api/mix?date=${state.date}`);
    const days = mixDays();
    if (!days.includes(state.mixDay)) state.mixDay = days.length > 1 && days[days.length - 1] === madridNow().date ? days[days.length - 2] : days[days.length - 1];
  } catch { state.mix = null; }
  renderMixChips(); renderMix(); renderMixBars(); renderKPIs();
}
async function loadSlow() {
  const jobs = [
    getJSON('/api/systems').then(j => { state.systems = j; renderSystems(); }),
    getJSON('/api/national').then(j => { state.national = j; renderNational(); }),
    getJSON('/api/ire').then(j => { state.ire = j; renderIRE(); }),
    getJSON('/api/regions').then(j => { state.regions = j; renderRegions(); }),
  ];
  await Promise.allSettled(jobs);
}

let timer = null;
function schedule() {
  clearTimeout(timer);
  if (!state.refresh || !isToday()) { state.nextAt = 0; renderStatus(); return; }
  state.nextAt = Date.now() + state.refresh * 1000;
  timer = setTimeout(async () => {
    await loadRealtime();
    schedule();
  }, state.refresh * 1000);
}

// ---------------- Controles ----------------
function initControls() {
  const dateIn = $('#date');
  const today = madridNow().date;
  dateIn.value = state.date; dateIn.max = today; dateIn.min = '2015-01-01';
  dateIn.addEventListener('change', async () => {
    if (!dateIn.value || dateIn.value > madridNow().date) { dateIn.value = state.date; return; }
    state.date = dateIn.value; state.rt = null; state.prices = null; state.mix = null; state.mixDay = null;
    renderKPIs(); renderMain(); renderDev(); renderPrices(); renderMix(); renderMixBars(); renderStatus();
    await Promise.all([loadRealtime(), loadPrices(), loadMix()]);
    schedule();
  });
  const ref = $('#refresh');
  ref.value = String(state.refresh);
  if (!ref.value) { ref.value = '60'; state.refresh = 60; }
  ref.addEventListener('change', () => { state.refresh = Number(ref.value); store.set('refresh', ref.value); schedule(); });
  $('#mainToggles').addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    const k = b.dataset.k; state.show[k] = !state.show[k]; b.classList.toggle('on', state.show[k]);
    $('#tariffLegend').hidden = !state.show.tariff;
    renderMain();
  });
  $('#mixDays').addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    state.mixDay = b.dataset.d; renderMixChips(); renderMix(); renderKPIs();
  });
  $('#regMetric').addEventListener('change', renderRegions);
  $('#regMonth').addEventListener('change', renderRegions);
  const saved = store.get('theme');
  if (saved) document.documentElement.dataset.theme = saved;
  $('#themeBtn').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    store.set('theme', document.documentElement.dataset.theme);
    renderAll();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', renderAll);
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && isToday() && state.refresh && Date.now() > state.nextAt) { await loadRealtime(); schedule(); }
  });
  // Al cambiar de día a medianoche, saltar al nuevo día si se estaba viendo "hoy"
  let lastToday = today;
  setInterval(() => {
    const t = madridNow().date;
    if (t !== lastToday) { const wasToday = state.date === lastToday; lastToday = t; dateIn.max = t; if (wasToday) { dateIn.value = t; dateIn.dispatchEvent(new Event('change')); } }
    renderStatus();
  }, 1000);
  setInterval(() => { if (isToday()) { loadPrices(); loadMix(); } }, 10 * 60 * 1000);
  setInterval(() => { if (document.visibilityState === 'visible') { renderMain(); renderPrices(); } }, 60 * 1000);
}
function renderAll() {
  renderKPIs(); renderMain(); renderDev(); renderPrices(); renderMix(); renderMixBars(); renderSystems(); renderRegions(); renderIRE(); renderNational(); renderStatus();
}

// ---------------- Arranque ----------------
(async function main() {
  if (new URLSearchParams(location.search).has('solo')) document.body.classList.add('solo');
  initControls();
  register($('#mainChart'), renderMain);
  register($('#devChart'), renderDev);
  register($('#priceChart'), renderPrices);
  register($('#mixDonut'), renderMix);
  register($('#mixBars'), renderMixBars);
  register($('#regMap'), renderRegions);
  register($('#ireChart'), renderIRE);
  register($('#natChart'), renderNational);
  renderKPIs(); renderSystems(); renderStatus();
  await Promise.all([loadRealtime(), loadPrices(), loadMix()]);
  schedule();
  loadSlow();
})();
