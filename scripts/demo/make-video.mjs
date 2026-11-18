// Edits a recording from record-demo.mjs into the submission video:
//   - keeps the stretch from the first caption to the end of Task C;
//   - plays model waiting time faster (never cut), labelled on screen with its speed;
//   - burns in the captions and adds a voice-over spoken from them (Windows speech, offline);
//   - adds a title card and a summary card;
//   - fits the whole video under 4 minutes;
//   - writes scorecard.md with the video timestamp of each scoring moment.
//
//   node scripts/demo/make-video.mjs <output folder of record-demo.mjs>
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] ?? '.');
const timeline = JSON.parse(readFileSync(path.join(out, 'timeline.json'), 'utf-8'));
const { t0, cropBottom = 0 } = JSON.parse(readFileSync(path.join(out, 'recording.json'), 'utf-8'));
const results = existsSync(path.join(out, 'demo-results.json')) ? JSON.parse(readFileSync(path.join(out, 'demo-results.json'), 'utf-8')) : {};

const TITLE = 6;
const END = 10;
const TARGET = 236; // seconds; the limit is 240
const rel = (t) => (t - t0) / 1000;
const markAt = (name) => timeline.find((e) => e.kind === 'mark' && e.name === name);
const start = Math.max(0, rel(markAt('start')?.t ?? timeline[0].t) - 0.5);
const end = rel(markAt('end')?.t ?? timeline.at(-1).t) + 1.5;

// ---- Segments of normal and fast playback.
const segments = [];
let cursor = start;
let fastNow = false;
for (const e of timeline.filter((x) => x.kind === 'fast')) {
  const t = Math.min(Math.max(rel(e.t), start), end);
  if (t - cursor > 0.05) segments.push({ from: cursor, to: t, fast: fastNow });
  cursor = Math.max(cursor, t);
  fastNow = e.on;
}
if (end - cursor > 0.05) segments.push({ from: cursor, to: end, fast: fastNow });
const normal = segments.filter((s) => !s.fast).reduce((n, s) => n + s.to - s.from, 0);
const fastTotal = segments.filter((s) => s.fast).reduce((n, s) => n + s.to - s.from, 0);
const room = TARGET - TITLE - END - normal;
if (room < 8) console.warn(`Warning: normal-speed parts alone take ${normal.toFixed(0)} s; the video will exceed 4 minutes. Shorten captions or holds.`);
const speed = fastTotal > 0 ? Math.min(120, Math.max(4, fastTotal / Math.max(8, room))) : 1;

/** Output time (seconds, including the title card) of a recording time. */
function map(t) {
  let o = TITLE;
  for (const s of segments) {
    if (t <= s.from) break;
    const d = Math.min(t, s.to) - s.from;
    o += s.fast ? d / speed : d;
    if (t <= s.to) break;
  }
  return o;
}
const mainLength = map(end) - TITLE;
const total = TITLE + mainLength + END;

// ---- Captions (ASS, burned in) and the voice-over schedule.
const ts = (sec) => {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const cs = Math.round((s - h * 3600 - m * 60) * 100) / 100;
  return `${h}:${String(m).padStart(2, '0')}:${cs.toFixed(2).padStart(5, '0')}`;
};
const assText = (s) => s.replace(/[{}]/g, '').replace(/\\/g, '/').replace(/\n/g, '\\N');
const header = (styles) =>
  [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1920',
    'PlayResY: 1080',
    'WrapStyle: 0',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styles,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');
const STYLE_CAP = 'Style: Cap,Segoe UI,38,&H00FFFFFF,&H000000FF,&H30101010,&H00000000,0,0,0,0,100,100,0,0,3,12,0,8,220,220,14,1';
const STYLE_FAST = 'Style: Fast,Segoe UI Semibold,30,&H0000D7FF,&H000000FF,&H30101010,&H00000000,0,0,0,0,100,100,0,0,3,10,0,9,30,30,90,1';

const captions = timeline.filter((e) => e.kind === 'caption');
const events = [];
const narration = [];
captions.forEach((c, k) => {
  const from = map(rel(c.t) < start ? start : rel(c.t)) - TITLE;
  const nextFrom = k + 1 < captions.length ? map(rel(captions[k + 1].t)) - TITLE : mainLength;
  // One caption at a time: each ends where the next begins (at most 9 s on screen).
  const to = Math.min(nextFrom, from + 9, mainLength);
  if (to - from < 0.4) return;
  events.push(`Dialogue: 0,${ts(from)},${ts(to)},Cap,,0,0,0,,${assText(c.text)}`);
  // Status notes in parentheses are shown, not spoken.
  const spoken = c.text.replace(/Ctrl\+;/g, 'Control semicolon').replace(/^\s*\(.*\)\s*$/, '').trim();
  if (spoken) narration.push({ id: `c${String(k).padStart(2, '0')}`, text: spoken, at: from + TITLE });
});
for (const s of segments.filter((x) => x.fast)) {
  const from = map(s.from) - TITLE;
  const to = map(s.to) - TITLE;
  if (to - from > 0.3) events.push(`Dialogue: 1,${ts(from)},${ts(to)},Fast,,0,0,0,,model time ×${Math.round(speed)}`);
}
writeFileSync(path.join(out, 'captions.ass'), `${header([STYLE_CAP, STYLE_FAST])}\n${events.join('\n')}\n`, 'utf-8');

// ---- Title and summary cards.
const STYLE_T1 = 'Style: T1,Segoe UI Semibold,96,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,100,100,0,1';
const STYLE_T2 = 'Style: T2,Segoe UI,40,&H00E0E0E0,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,120,120,0,1';
const STYLE_T3 = 'Style: T3,Segoe UI,28,&H009A9A9A,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,120,120,60,1';
const STYLE_L = 'Style: L,Segoe UI,40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,4,220,120,0,1';
const card = (name, dur, lines) => writeFileSync(path.join(out, `${name}.ass`), `${header([STYLE_T1, STYLE_T2, STYLE_T3, STYLE_L])}\n${lines.map((l) => `Dialogue: 0,${ts(0)},${ts(dur)},${l}`).join('\n')}\n`, 'utf-8');
card('title', TITLE, [
  'T1,,0,0,0,,{\\pos(960,420)}Ripple',
  'T2,,0,0,0,,{\\pos(960,540)}An editor-native coding agent whose loop runs on TrueForge',
  'T2,,0,0,0,,{\\pos(960,610)}Forge-a-thon Round 1: Tasks A, B and C on pallets/flask 3.1.3',
  'T3,,0,0,0,,Scripted demo: clicks and typing are automated; the models, edits, tests and results are real.',
]);
const filesB = results.taskB?.files?.length ? results.taskB.files.join(', ') : 'three files';
card('end', END, [
  'T2,,0,0,0,,{\\pos(960,190)\\fs56}What you saw',
  `L,,0,0,0,,{\\pos(220,330)}• Inline edit: a diff in the editor, accepted hunk by hunk, undone in one step`,
  `L,,0,0,0,,{\\pos(220,410)}• Agent mode: found and changed ${filesB} with no files named`,
  `L,,0,0,0,,{\\pos(220,490)}• Context: budgeted retrieval with a receipt of every file and why`,
  `L,,0,0,0,,{\\pos(220,570)}• On TrueForge: MCP tools, approval opens the review, compaction`,
  `L,,0,0,0,,{\\pos(220,650)}• A dead model endpoint: automatic fallback, workspace unchanged`,
  'T3,,0,0,0,,Models: Gemini 3.1 and 3.5 Flash-Lite (free tier) and a local Qwen 2.5 Coder 7B. Total model cost: $0.',
]);
narration.unshift({ id: 'title', text: 'Ripple: an editor-native coding agent, built on TrueForge. Here are tasks A, B, and C, in order.', at: 0.6 });
narration.push({
  id: 'end',
  text: 'Inline edit with per-hunk review and undo. An agent that finds its own files and shows why. Built on TrueForge, and it survives a dead model.',
  at: TITLE + mainLength + 0.6,
});

// ---- Voice-over: synthesize, then schedule without overlaps (drop a line if it would start late).
const ff = (argv) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...argv], { cwd: out, stdio: ['ignore', 'inherit', 'inherit'] });
const probe = (f) => {
  try {
    return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { cwd: out, encoding: 'utf-8' }).trim());
  } catch {
    return NaN;
  }
};
writeFileSync(path.join(out, 'narration.json'), JSON.stringify(narration.map(({ id, text }) => ({ id, text }))), 'utf-8');
execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'tts.ps1'), '-List', path.join(out, 'narration.json'), '-OutDir', out], { stdio: 'inherit' });
let free = 0;
const placed = [];
for (const n of narration) {
  const len = probe(path.join(out, `${n.id}.wav`));
  if (!Number.isFinite(len) || len <= 0) continue;
  const at = Math.max(n.at, free + 0.15);
  if (at - n.at > 2.5 || at + len > total - 0.2) continue;
  placed.push({ ...n, at, len });
  free = at + len;
}

// ---- Render: main (trimmed, sped up, captions), cards, then join with the voice-over.
const filters = segments.map((s, k) => `[0:v]trim=start=${s.from.toFixed(3)}:end=${s.to.toFixed(3)},setpts=(PTS-STARTPTS)${s.fast ? `/${speed.toFixed(3)}` : ''}[v${k}]`);
// The taskbar is cropped off; the picture is centred on a 1920x1080 canvas.
const crop = cropBottom > 0 ? `,crop=iw:ih-${cropBottom}:0:0,pad=1920:1080:0:${Math.floor(cropBottom / 2)}:color=0x0d1117` : '';
filters.push(`${segments.map((_, k) => `[v${k}]`).join('')}concat=n=${segments.length}:v=1:a=0,fps=30${crop},subtitles=captions.ass[vout]`);
writeFileSync(path.join(out, 'main-filter.txt'), filters.join(';\n'), 'utf-8');
// ffmpeg 7+ reads an option's value from a file with a leading slash (-/filter_complex).
ff(['-i', 'raw.mp4', '-/filter_complex', 'main-filter.txt', '-map', '[vout]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', 'main.mp4']);
for (const [name, dur] of [['title', TITLE], ['end', END]]) {
  ff(['-f', 'lavfi', '-i', `color=c=0x0d1117:s=1920x1080:r=30:d=${dur}`, '-vf', `subtitles=${name}.ass`, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', `${name}.mp4`]);
}
const audioInputs = placed.flatMap((p) => ['-i', `${p.id}.wav`]);
const audioFilter =
  placed.map((p, k) => `[${k + 3}:a]adelay=${Math.round(p.at * 1000)}:all=1[a${k}]`).join(';') +
  `;${placed.map((_, k) => `[a${k}]`).join('')}amix=inputs=${placed.length}:normalize=0,apad,atrim=0:${total.toFixed(2)}[aout]`;
ff([
  '-i', 'title.mp4', '-i', 'main.mp4', '-i', 'end.mp4', ...audioInputs,
  '-filter_complex', `[0:v][1:v][2:v]concat=n=3:v=1:a=0[vout];${audioFilter}`,
  '-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
  'ripple-demo.mp4',
]);

// ---- Scorecard timestamps for the write-up.
const mmss = (sec) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const at = (name) => (markAt(name) ? mmss(map(rel(markAt(name).t))) : 'not shown');
const rows = [
  ['A1 Inline edit', at('A1-review'), 'Diff in the editor with per-hunk Accept and Reject (reject shown in Task C)'],
  ['A2 Agent mode', at('A2-files'), `Task B: the agent found and changed ${filesB} with no files named`],
  ['A3 Streaming and cancel', at('A3-cancel'), 'Tokens stream; cancel stops the run at once, git status clean'],
  ['B1 Context assembly', at('B1-receipt'), 'Budgeted retrieval; the receipt shows each file chosen and why'],
  ['B2 Diff safety', at('B2-undo'), 'Nothing written before acceptance; one undo restores the files'],
  ['B3 Resilience', at('B3-fallback'), 'Task C: endpoint unreachable, the second model takes over, workspace unchanged'],
  ['B4 TrueForge depth', at('B4-session'), `MCP tools, approval opens the review, compaction${markAt('B4-compaction') ? ` (at ${at('B4-compaction')})` : ''}, the session in TrueForge`],
  ['Task A / B / C start', `${at('taskA')} / ${at('taskB')} / ${at('taskC')}`, 'Tasks in order, each verified on screen'],
];
writeFileSync(
  path.join(out, 'scorecard.md'),
  `| Criterion | Video | Claim |\n|---|---|---|\n${rows.map((r) => `| ${r.join(' | ')} |`).join('\n')}\n`,
  'utf-8',
);

const final = probe(path.join(out, 'ripple-demo.mp4'));
console.log(`\nVideo: ${path.join(out, 'ripple-demo.mp4')}`);
console.log(`Length ${mmss(final)} (${final.toFixed(1)} s); model time played ×${speed.toFixed(1)}; ${placed.length} of ${narration.length} narration lines placed.`);
console.log(`Scorecard timestamps: ${path.join(out, 'scorecard.md')}`);
if (final > 240) console.warn('Warning: longer than 4 minutes.');
