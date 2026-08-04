#!/usr/bin/env node
//
// Genera la terminal animada del README como dos SVG autocontenidos
// (tema claro y oscuro). Sin dependencias: solo Node 18+.
//
//   node scripts/build-terminal.mjs
//
// Con GITHUB_TOKEN usa la API GraphQL (más exacta, y puede incluir
// contribuciones privadas). Sin token cae al calendario público, que
// siempre está disponible pero solo cuenta actividad pública.

import { writeFile, mkdir } from 'node:fs/promises';

// ─────────────────────────────────────────────────────────────────────
// Lo que dice la terminal. Esta es la parte que editas a mano.
// ─────────────────────────────────────────────────────────────────────

const PROFILE = {
  login: 'AxlLuna',
  host: 'urvenue',
  name: 'Axl Eduardo Guillen Luna',
  tagline: 'Full-stack · plataformas para eventos y vida nocturna',
  stack: [
    ['lenguaje', 'typescript · javascript'],
    ['runtime', 'node'],
    ['dominio', 'geoespacial · chatbots · ticketing'],
    ['enfoque', 'apis, integraciones y datos en tiempo real'],
  ],
};

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

// ─────────────────────────────────────────────────────────────────────
// Paletas Tokyo Night
// ─────────────────────────────────────────────────────────────────────

const THEMES = {
  dark: {
    name: 'dark',
    bg: '#1a1b26',
    chrome: '#16161e',
    border: '#292e42',
    fg: '#c0caf5',
    dim: '#565f89',
    green: '#9ece6a',
    cyan: '#7dcfff',
    blue: '#7aa2f7',
    purple: '#bb9af7',
    yellow: '#e0af68',
    dot: ['#f7768e', '#e0af68', '#9ece6a'],
    ramp: ['#292e42', '#3b5b8c', '#4f8ac4', '#7dcfff', '#bb9af7'],
  },
  light: {
    name: 'light',
    bg: '#e1e2e7',
    chrome: '#d4d6e1',
    border: '#c4c8da',
    fg: '#3760bf',
    dim: '#848cb5',
    green: '#587539',
    cyan: '#007197',
    blue: '#2e7de9',
    purple: '#9854f1',
    yellow: '#8c6c3e',
    dot: ['#f52a65', '#8c6c3e', '#587539'],
    ramp: ['#c4c8da', '#a3bdf0', '#6f9fe8', '#2e7de9', '#9854f1'],
  },
};

// ─────────────────────────────────────────────────────────────────────
// Geometría. La terminal es monoespaciada, así que todo se calcula
// a partir del avance de un caracter.
// ─────────────────────────────────────────────────────────────────────

const W = 820;          // ancho total
const CH = 7.8;         // avance de un caracter a 13px
const FS = 13;          // tamaño de fuente
const LH = 21;          // alto de línea
const PAD_X = 24;       // margen interno horizontal
const PAD_Y = 20;       // margen interno vertical
const CHROME = 36;      // alto de la barra de título
const GRAPH_H = 54;     // alto de las barras
const AXIS_H = 16;      // alto del eje de meses

const FONT =
  "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Monaco,Consolas," +
  "'DejaVu Sans Mono','Liberation Mono','Courier New',monospace";

// Ritmo de la animación, en segundos.
const T = {
  lead: 0.35,      // pausa antes de empezar a teclear
  perChar: 0.032,  // velocidad de tecleo
  enter: 0.34,     // pausa después de dar enter
  perOut: 0.09,    // cada línea de salida
  blank: 0.14,     // línea en blanco
  perBar: 0.026,   // cada barra de la gráfica
};

// ─────────────────────────────────────────────────────────────────────
// Datos
// ─────────────────────────────────────────────────────────────────────

const GQL = `query($login:String!){
  user(login:$login){
    contributionsCollection{
      totalCommitContributions
      restrictedContributionsCount
      contributionCalendar{
        totalContributions
        weeks{ contributionDays{ date contributionCount contributionLevel } }
      }
    }
  }
}`;

const LEVELS = {
  NONE: 0,
  FIRST_QUARTILE: 1,
  SECOND_QUARTILE: 2,
  THIRD_QUARTILE: 3,
  FOURTH_QUARTILE: 4,
};

async function fetchViaGraphQL(login, token) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'build-terminal',
    },
    body: JSON.stringify({ query: GQL, variables: { login } }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL: ${json.errors[0].message}`);

  const c = json.data.user.contributionsCollection;
  const days = c.contributionCalendar.weeks.flatMap((w) =>
    w.contributionDays.map((d) => ({
      date: d.date,
      count: d.contributionCount,
      level: LEVELS[d.contributionLevel] ?? 0,
    })),
  );
  return {
    days,
    total: c.contributionCalendar.totalContributions,
    commits: c.totalCommitContributions,
    private: c.restrictedContributionsCount,
    source: 'graphql',
  };
}

async function fetchViaPublicHTML(login) {
  const res = await fetch(`https://github.com/users/${login}/contributions`, {
    headers: { 'User-Agent': 'build-terminal' },
  });
  if (!res.ok) throw new Error(`calendario público HTTP ${res.status}`);
  const html = await res.text();

  // Cada día es un <td data-date="…" data-level="…" id="…">, y su conteo
  // vive en el <tool-tip for="ese-id">.
  const counts = new Map();
  for (const m of html.matchAll(/<tool-tip[^>]*for="([^"]+)"[^>]*>([^<]*)<\/tool-tip>/g)) {
    const n = /^(\d+)\s+contribution/.exec(m[2].trim());
    counts.set(m[1], n ? Number(n[1]) : 0);
  }

  const days = [];
  for (const m of html.matchAll(/<td[^>]*class="ContributionCalendar-day"[^>]*>/g)) {
    const tag = m[0];
    const date = /data-date="([^"]+)"/.exec(tag)?.[1];
    if (!date) continue;
    const id = /\bid="([^"]+)"/.exec(tag)?.[1] ?? '';
    days.push({
      date,
      count: counts.get(id) ?? 0,
      level: Number(/data-level="(\d)"/.exec(tag)?.[1] ?? 0),
    });
  }
  if (!days.length) throw new Error('no se pudo leer el calendario público');

  days.sort((a, b) => a.date.localeCompare(b.date));
  const total = days.reduce((s, d) => s + d.count, 0);
  return { days, total, commits: null, private: 0, source: 'público' };
}

/**
 * La racha más larga del periodo. Preferimos esta sobre la racha actual:
 * es igual de honesta y no depende de si hoy ya hubo commit.
 */
function bestStreak(days) {
  let best = 0;
  let run = 0;
  for (const day of days) {
    run = day.count > 0 ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

/** Agrupa los días en semanas de domingo a sábado. */
function toWeeks(days) {
  const weeks = [];
  let week = null;
  for (const day of days) {
    const dow = new Date(`${day.date}T00:00:00Z`).getUTCDay();
    if (dow === 0 || !week) {
      week = { start: day.date, total: 0, level: 0 };
      weeks.push(week);
    }
    week.total += day.count;
    week.level = Math.max(week.level, day.level);
  }
  return weeks;
}

// ─────────────────────────────────────────────────────────────────────
// Construcción del SVG
// ─────────────────────────────────────────────────────────────────────

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const n = (v) => Math.round(v * 100) / 100;

/** Acumula elementos y lleva la cuenta del tiempo y de la línea actual. */
class Session {
  constructor(theme) {
    this.t = 0;
    this.theme = theme;
    this.parts = [];
    this.defs = [];
    this.y = CHROME + PAD_Y + FS; // línea base de la primera línea
    this.clipId = 0;
  }

  get promptWidth() {
    return `${PROFILE.login.toLowerCase()}@${PROFILE.host} ~ $ `.length * CH;
  }

  /** Una línea de comando: el prompt aparece y el comando se teclea. */
  command(cmd) {
    const { theme, y } = this;
    const user = `${PROFILE.login.toLowerCase()}@${PROFILE.host}`;
    const at = PAD_X;
    const cmdX = at + this.promptWidth;
    const cmdW = cmd.length * CH;
    const start = n(this.t + T.lead);
    const dur = n(Math.max(0.2, cmd.length * T.perChar));
    const end = n(start + dur);
    const id = `t${this.clipId++}`;

    this.defs.push(
      `<clipPath id="${id}"><rect x="${n(cmdX)}" y="${n(y - FS)}" height="${FS + 5}" width="0">` +
        `<animate attributeName="width" from="0" to="${n(cmdW)}" begin="${start}s" dur="${dur}s" fill="freeze"/>` +
        `</rect></clipPath>`,
    );

    // prompt
    this.parts.push(
      `<g opacity="0"><set attributeName="opacity" to="1" begin="${n(this.t)}s"/>` +
        `<text x="${at}" y="${n(y)}">` +
        `<tspan fill="${theme.green}">${esc(user)}</tspan>` +
        `<tspan fill="${theme.dim}"> </tspan>` +
        `<tspan fill="${theme.cyan}">~</tspan>` +
        `<tspan fill="${theme.dim}"> $</tspan>` +
        `</text></g>`,
    );

    // comando, revelado caracter por caracter
    this.parts.push(
      `<g clip-path="url(#${id})"><text x="${n(cmdX)}" y="${n(y)}" fill="${theme.fg}">${esc(cmd)}</text></g>`,
    );

    // cursor que acompaña al tecleo y desaparece al terminar
    this.parts.push(
      `<g opacity="0">` +
        `<set attributeName="opacity" to="1" begin="${start}s"/>` +
        `<set attributeName="opacity" to="0" begin="${end}s"/>` +
        `<rect y="${n(y - FS + 2)}" width="${n(CH)}" height="${FS + 2}" fill="${theme.purple}" x="${n(cmdX)}">` +
        `<animate attributeName="x" from="${n(cmdX)}" to="${n(cmdX + cmdW)}" begin="${start}s" dur="${dur}s" fill="freeze"/>` +
        `</rect></g>`,
    );

    this.t = n(end + T.enter);
    this.y += LH;
    return this;
  }

  /** Una línea de salida. `spans` es [[texto, color], …]. */
  out(spans) {
    let x = PAD_X;
    const body = spans
      .map(([text, fill]) => {
        const el = `<tspan x="${n(x)}" fill="${fill}">${esc(text)}</tspan>`;
        x += text.length * CH;
        return el;
      })
      .join('');
    this.parts.push(
      `<g opacity="0"><set attributeName="opacity" to="1" begin="${n(this.t)}s"/>` +
        `<text y="${n(this.y)}">${body}</text></g>`,
    );
    this.t = n(this.t + T.perOut);
    this.y += LH;
    return this;
  }

  blank() {
    this.t = n(this.t + T.blank);
    this.y += LH * 0.55;
    return this;
  }

  /** La gráfica: una barra por semana, creciendo de izquierda a derecha. */
  graph(weeks) {
    const { theme } = this;
    const inner = W - PAD_X * 2;
    const gap = 4.4;
    const bw = (inner - gap * (weeks.length - 1)) / weeks.length;
    const base = this.y + GRAPH_H - FS;
    const max = Math.max(1, ...weeks.map((w) => w.total));
    const start = this.t;

    weeks.forEach((week, i) => {
      const x = PAD_X + i * (bw + gap);
      // Escala de raíz cuadrada: una sola semana pico no aplasta al resto.
      const h = week.total === 0 ? 2.5 : Math.max(5, Math.sqrt(week.total / max) * GRAPH_H);
      const begin = n(start + i * T.perBar);
      this.parts.push(
        `<rect x="${n(x)}" width="${n(bw)}" rx="1.4" fill="${theme.ramp[week.level]}" y="${n(base)}" height="0">` +
          `<animate attributeName="y" from="${n(base)}" to="${n(base - h)}" begin="${begin}s" dur="0.42s" fill="freeze"/>` +
          `<animate attributeName="height" from="0" to="${n(h)}" begin="${begin}s" dur="0.42s" fill="freeze"/>` +
          `</rect>`,
      );
    });

    // eje: la abreviatura del mes en la semana donde empieza
    const axisY = base + AXIS_H;
    let last = -1;
    weeks.forEach((week, i) => {
      const month = new Date(`${week.start}T00:00:00Z`).getUTCMonth();
      if (month === last) return;
      last = month;
      // El último mes se repite con el primero al cerrar el año: lo omitimos
      // si ya casi no quedan semanas para dibujarlo.
      if (weeks.length - i < 3) return;
      const x = PAD_X + i * (bw + gap);
      this.parts.push(
        `<g opacity="0"><set attributeName="opacity" to="1" begin="${n(start + i * T.perBar)}s"/>` +
          `<text x="${n(x)}" y="${n(axisY)}" font-size="10" fill="${theme.dim}">${MESES[month]}</text></g>`,
      );
    });

    this.t = n(start + weeks.length * T.perBar + 0.5);
    this.y = axisY + LH;
    return this;
  }

  /** El cursor final, que se queda latiendo. */
  idle() {
    const { theme, y } = this;
    const user = `${PROFILE.login.toLowerCase()}@${PROFILE.host}`;
    this.parts.push(
      `<g opacity="0"><set attributeName="opacity" to="1" begin="${n(this.t)}s"/>` +
        `<text x="${PAD_X}" y="${n(y)}">` +
        `<tspan fill="${theme.green}">${esc(user)}</tspan>` +
        `<tspan fill="${theme.dim}"> </tspan>` +
        `<tspan fill="${theme.cyan}">~</tspan>` +
        `<tspan fill="${theme.dim}"> $</tspan>` +
        `</text>` +
        `<rect class="cursor" x="${n(PAD_X + this.promptWidth)}" y="${n(y - FS + 2)}" ` +
        `width="${n(CH)}" height="${FS + 2}" fill="${theme.purple}"/>` +
        `</g>`,
    );
    this.y += LH;
    return this;
  }

  render() {
    const { theme } = this;
    const H = Math.round(this.y - FS + PAD_Y);
    const title = `${PROFILE.login.toLowerCase()} — zsh`;
    const dots = theme.dot
      .map((c, i) => `<circle cx="${20 + i * 17}" cy="${CHROME / 2}" r="5.5" fill="${c}"/>`)
      .join('');

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}" font-size="${FS}" role="img" aria-label="Terminal con el perfil y las contribuciones de ${esc(PROFILE.name)}">
<title>${esc(PROFILE.name)} — ${esc(PROFILE.tagline)}</title>
<style>
@keyframes blink{0%,49%{opacity:1}50%,100%{opacity:0}}
.cursor{animation:blink 1.06s steps(1) infinite}
@media (prefers-reduced-motion:reduce){.cursor{animation:none}}
text{white-space:pre;dominant-baseline:alphabetic}
</style>
<defs>
${this.defs.join('\n')}
</defs>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="11" fill="${theme.bg}" stroke="${theme.border}"/>
<path d="M0.5 11.5a11 11 0 0 1 11-11h${W - 23}a11 11 0 0 1 11 11V${CHROME}H0.5Z" fill="${theme.chrome}"/>
<line x1="0.5" y1="${CHROME}" x2="${W - 0.5}" y2="${CHROME}" stroke="${theme.border}"/>
${dots}
<text x="${W / 2}" y="${CHROME / 2 + 4}" text-anchor="middle" font-size="11" fill="${theme.dim}">${esc(title)}</text>
${this.parts.join('\n')}
</svg>
`;
  }
}

function buildSVG(theme, data) {
  const { total, streak, active, weeks } = data;
  const s = new Session(theme);
  const nf = new Intl.NumberFormat('es-MX');

  s.command('whoami')
    .out([[PROFILE.name, theme.fg]])
    .out([[PROFILE.tagline, theme.dim]])
    .blank();

  s.command('cat stack.yml');
  const pad = Math.max(...PROFILE.stack.map(([k]) => k.length));
  for (const [key, value] of PROFILE.stack) {
    s.out([
      [`${key}:`, theme.blue],
      [' '.repeat(pad - key.length + 2), theme.dim],
      [value, theme.fg],
    ]);
  }
  s.blank();

  s.command('gh contrib --summary').out([
    [nf.format(total), theme.yellow],
    [' contribuciones   ', theme.dim],
    [String(active), theme.yellow],
    [' días activos   ', theme.dim],
    ['mejor racha ', theme.dim],
    [String(streak), theme.yellow],
    [streak === 1 ? ' día' : ' días', theme.dim],
  ]);
  s.blank();

  s.command(`gh contrib --graph --last ${weeks.length}w`).graph(weeks).blank();

  s.idle();
  return s.render();
}

// ─────────────────────────────────────────────────────────────────────

async function main() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  let raw;
  if (token) {
    raw = await fetchViaGraphQL(PROFILE.login, token);
  } else {
    console.warn('· sin GITHUB_TOKEN: uso el calendario público (solo actividad pública)');
    raw = await fetchViaPublicHTML(PROFILE.login);
  }

  const data = {
    ...raw,
    streak: bestStreak(raw.days),
    active: raw.days.filter((d) => d.count > 0).length,
    weeks: toWeeks(raw.days),
  };

  await mkdir('assets', { recursive: true });
  for (const theme of Object.values(THEMES)) {
    const file = `assets/terminal-${theme.name}.svg`;
    await writeFile(file, buildSVG(theme, data));
    console.log(`✓ ${file}`);
  }

  console.log(
    `  fuente: ${data.source} · ${data.total} contribuciones · ` +
      `${data.active} días activos · mejor racha ${data.streak} · ${data.weeks.length} semanas`,
  );
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
