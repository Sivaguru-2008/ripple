import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const out = path.resolve('e:/ripples/demo-out/2026-11-18T18-07-32');
const timeline = JSON.parse(readFileSync(path.join(out, 'timeline.json'), 'utf-8'));
const { t0, cropBottom = 60 } = JSON.parse(readFileSync(path.join(out, 'recording.json'), 'utf-8'));
const masks = existsSync(path.join(out, 'masks.json')) ? JSON.parse(readFileSync(path.join(out, 'masks.json'), 'utf-8')) : [];

const rel = (t) => (t - t0) / 1000;
const markAt = (name) => timeline.find((e) => e.kind === 'mark' && e.name === name);

const ff = (argv, cwd = out) => {
  console.log('ffmpeg', argv.slice(0, 6).join(' '), '...');
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...argv], { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
};

const probe = (f) => {
  try {
    return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { cwd: out, encoding: 'utf-8' }).trim());
  } catch {
    return NaN;
  }
};

const ts = (sec) => {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const cs = Math.round((s - h * 3600 - m * 60) * 100) / 100;
  return `${h}:${String(m).padStart(2, '0')}:${cs.toFixed(2).padStart(5, '0')}`;
};

const assText = (s) => s.replace(/[{}]/g, '').replace(/\\/g, '/').replace(/\n/g, '\\N');

const header = (styles) => [
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

// libass styles:
const STYLE_BADGE = 'Style: Badge,Segoe UI Semibold,22,&H00FFFFFF,&H000000FF,&H00D7FF,&H900d1117,1,0,0,0,100,100,0,0,3,10,0,9,40,40,45,1';
const STYLE_CALLOUT = 'Style: Callout,Segoe UI Semibold,23,&H00D7FF,&H000000FF,&H30101010,&H900d1117,1,0,0,0,100,100,0,0,3,12,0,9,40,40,95,1';
const STYLE_BANNER = 'Style: Banner,Segoe UI Semibold,28,&H0000D7FF,&H000000FF,&H30101010,&H900d1117,1,0,0,0,100,100,0,0,3,14,0,8,40,40,40,1';
const STYLE_CAP = 'Style: Cap,Segoe UI,32,&H00FFFFFF,&H000000FF,&H30101010,&H900d1117,0,0,0,0,100,100,0,0,3,12,0,2,100,100,24,1';
const STYLE_FAST = 'Style: Fast,Consolas,24,&H0000D7FF,&H000000FF,&H30101010,&H900d1117,1,0,0,0,100,100,0,0,3,10,0,9,40,40,145,1';

console.log('--- Phase 1: Generating Card Videos ---');
const cardConfigs = [
  { name: 'open_01', dur: 5.0,  img: 'open_01.png' },
  { name: 'open_02', dur: 8.2,  img: 'open_02.png' },
  { name: 'open_03', dur: 5.5,  img: 'open_03.png' },
  { name: 'arch',    dur: 13.5, img: 'arch_diagram.png' },
  { name: 'sec_01',  dur: 2.0,  img: 'sec_01_control.png' },
  { name: 'sec_02',  dur: 2.5,  img: 'sec_02_transparency.png' },
  { name: 'sec_03',  dur: 2.5,  img: 'sec_03_resilience.png' },
  { name: 'closing', dur: 9.0,  img: 'closing.png' },
];

for (const card of cardConfigs) {
  ff([
    '-loop', '1',
    '-i', card.img,
    '-t', card.dur.toFixed(2),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-r', '30',
    `${card.name}.mp4`
  ]);
}

console.log('--- Phase 2: Processing VS Code Recording Segments ---');
const cropFilter = `crop=iw:ih-${cropBottom}:0:0,pad=1920:1080:0:${Math.floor(cropBottom / 2)}:color=0x0d1117`;
const MODEL_SPEED = 50;

function buildSegmentVideo(segName, rawSegments, assEvents, maskList = []) {
  console.log(`Building ${segName}...`);
  const filterLines = [];
  
  rawSegments.forEach((s, idx) => {
    const durScale = s.fast ? `/${s.speed.toFixed(3)}` : '';
    filterLines.push(`[0:v]trim=start=${s.from.toFixed(3)}:end=${s.to.toFixed(3)},setpts=(PTS-STARTPTS)${durScale}[v${idx}]`);
  });
  
  const concatInputs = rawSegments.map((_, idx) => `[v${idx}]`).join('');
  let currentV = 'c1';
  filterLines.push(`${concatInputs}concat=n=${rawSegments.length}:v=1:a=0,fps=30,${cropFilter}[${currentV}]`);
  
  if (maskList.length > 0) {
    maskList.forEach((m, idx) => {
      const blurV = `bl${idx}`;
      const nextV = `o${idx}`;
      filterLines.push(`[${currentV}]split=2[base${idx}][mk${idx}]`);
      filterLines.push(`[mk${idx}]crop=${m.w}:${m.h}:${m.x}:${m.y},boxblur=24:3[${blurV}]`);
      filterLines.push(`[base${idx}][${blurV}]overlay=${m.x}:${m.y}:enable='between(t,${m.from.toFixed(2)},${m.to.toFixed(2)})'[${nextV}]`);
      currentV = nextV;
    });
  }
  
  const assFile = `${segName}.ass`;
  const assContent = `${header([STYLE_BADGE, STYLE_CALLOUT, STYLE_BANNER, STYLE_CAP, STYLE_FAST])}\n${assEvents.join('\n')}\n`;
  writeFileSync(path.join(out, assFile), assContent, 'utf-8');
  
  filterLines.push(`[${currentV}]subtitles=${assFile}[vout]`);
  
  const filterScript = `${segName}_filter.txt`;
  writeFileSync(path.join(out, filterScript), filterLines.join(';\n'), 'utf-8');
  
  ff([
    '-i', 'raw.mp4',
    '-/filter_complex', filterScript,
    '-map', '[vout]',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '19',
    '-pix_fmt', 'yuv420p',
    '-r', '30',
    `${segName}.mp4`
  ]);
  
  const d = probe(path.join(out, `${segName}.mp4`));
  console.log(`Finished ${segName}: ${d.toFixed(2)}s`);
  return d;
}

// -------------------------------------------------------------
// SEGMENT 1: TASK A (Control - Inline Edit)
// -------------------------------------------------------------
const taskASegments = [
  { from: 5.57, to: 25.14, fast: false, speed: 1 },
  { from: 25.14, to: 35.00, fast: true, speed: MODEL_SPEED },
  { from: 35.00, to: 54.00, fast: false, speed: 1 },
  { from: 60.36, to: 65.50, fast: false, speed: 1 }
];

const mapA = (rawT) => {
  let res = 0;
  for (const s of taskASegments) {
    if (rawT <= s.from) break;
    const d = Math.min(rawT, s.to) - s.from;
    res += s.fast ? d / s.speed : d;
    if (rawT <= s.to) break;
  }
  return res;
};

// Zero-overlap strictly bounded intervals
const taskAEvents = [
  // Badges (Layer 1, pos(1860,60))
  `Dialogue: 1,${ts(0.0)},${ts(19.5)},Badge,,0,0,0,,{\\pos(1860,60)}01 — CONTROL | INLINE EDIT`,
  `Dialogue: 1,${ts(19.8)},${ts(27.0)},Badge,,0,0,0,,{\\pos(1860,60)}PER-HUNK REVIEW`,
  `Dialogue: 1,${ts(27.3)},${ts(37.0)},Badge,,0,0,0,,{\\pos(1860,60)}TEST VERIFICATION`,
  `Dialogue: 1,${ts(37.3)},${ts(43.9)},Badge,,0,0,0,,{\\pos(1860,60)}ATOMIC UNDO`,
  // Callouts (Layer 1, pos(1860,95))
  `Dialogue: 1,${ts(0.0)},${ts(8.5)},Callout,,0,0,0,,{\\pos(1860,95)}Selecting get_debug_flag in helpers.py`,
  `Dialogue: 1,${ts(8.8)},${ts(19.5)},Callout,,0,0,0,,{\\pos(1860,95)}Prompt: Treat 'off' and 'n' as false`,
  `Dialogue: 1,${ts(19.8)},${ts(27.0)},Callout,,0,0,0,,{\\pos(1860,95)}2 hunks proposed in editor diff tab`,
  `Dialogue: 1,${ts(27.3)},${ts(37.0)},Callout,,0,0,0,,{\\pos(1860,95)}FLASK_DEBUG=off -> prints False`,
  `Dialogue: 1,${ts(37.3)},${ts(43.9)},Callout,,0,0,0,,{\\pos(1860,95)}Undo restores original state completely`,
  // Fast indicator
  `Dialogue: 1,${ts(19.57)},${ts(19.77)},Fast,,0,0,0,,{\\pos(1860,145)}model time ×${MODEL_SPEED}`,
  // Subtitle captions for spoken voiceover (Layer 0, bottom center)
  `Dialogue: 0,${ts(0.5)},${ts(5.5)},Cap,,0,0,0,,For small changes, Ripple provides inline editing without sacrificing developer control.`,
  `Dialogue: 0,${ts(6.0)},${ts(11.0)},Cap,,0,0,0,,The instruction is submitted directly from the editor without switching windows.`,
  `Dialogue: 0,${ts(19.8)},${ts(26.5)},Cap,,0,0,0,,Every proposed hunk can be independently accepted or rejected, and accepted changes can be undone.`,
  `Dialogue: 0,${ts(27.3)},${ts(34.0)},Cap,,0,0,0,,Verification: with FLASK_DEBUG set to off, get_debug_flag returns False.`,
  `Dialogue: 0,${ts(37.3)},${ts(42.5)},Cap,,0,0,0,,One undo restores the original file. Git status is clean.`
];
const durTaskA = buildSegmentVideo('task_a', taskASegments, taskAEvents);

// -------------------------------------------------------------
// SEGMENT 2: CANCELLATION (Control - Ability to Stop)
// -------------------------------------------------------------
const cancelSegments = [
  { from: 73.47, to: 85.00, fast: false, speed: 1 }
];
const cancelEvents = [
  `Dialogue: 1,${ts(0.0)},${ts(11.5)},Banner,,0,0,0,,{\\pos(960,50)}CONTROL ALSO MEANS THE ABILITY TO STOP`,
  `Dialogue: 1,${ts(0.0)},${ts(6.0)},Callout,,0,0,0,,{\\pos(1860,95)}Turn started mid-run`,
  `Dialogue: 1,${ts(6.3)},${ts(11.5)},Callout,,0,0,0,,{\\pos(1860,95)}Cancel clicked: staged edits discarded cleanly`,
  `Dialogue: 0,${ts(0.4)},${ts(5.5)},Cap,,0,0,0,,Developers can interrupt an ongoing operation instead of allowing an unwanted agent run to continue.`,
  `Dialogue: 0,${ts(6.0)},${ts(11.0)},Cap,,0,0,0,,Cancellation stops execution immediately; workspace remains consistent and clean.`
];
const durCancel = buildSegmentVideo('cancel', cancelSegments, cancelEvents);

// -------------------------------------------------------------
// SEGMENT 3: TASK B (Transparency - Agent Mode & Context Receipt)
// -------------------------------------------------------------
const taskBSegments = [
  { from: 87.02, to: 93.60, fast: false, speed: 1 },
  { from: 93.60, to: 122.93, fast: true, speed: MODEL_SPEED },
  { from: 122.93, to: 135.15, fast: false, speed: 1 },
  { from: 135.15, to: 145.29, fast: true, speed: MODEL_SPEED },
  { from: 145.29, to: 148.42, fast: false, speed: 1 },
  { from: 148.42, to: 159.56, fast: true, speed: MODEL_SPEED },
  { from: 159.56, to: 162.69, fast: false, speed: 1 },
  { from: 162.69, to: 169.85, fast: true, speed: MODEL_SPEED },
  { from: 169.85, to: 180.81, fast: false, speed: 1 },
  { from: 180.81, to: 254.70, fast: true, speed: MODEL_SPEED },
  { from: 254.70, to: 257.83, fast: false, speed: 1 },
  { from: 257.83, to: 301.49, fast: true, speed: MODEL_SPEED },
  { from: 301.50, to: 327.04, fast: false, speed: 1 },
  { from: 327.04, to: 338.00, fast: false, speed: 1 },
  { from: 346.27, to: 352.00, fast: false, speed: 1 }
];

const mapB = (rawT) => {
  let res = 0;
  for (const s of taskBSegments) {
    if (rawT <= s.from) break;
    const d = Math.min(rawT, s.to) - s.from;
    res += s.fast ? d / s.speed : d;
    if (rawT <= s.to) break;
  }
  return res;
};

// Strict non-overlapping schedule for Task B
const taskBEvents = [
  // Badges (Layer 1, pos(1860,60))
  `Dialogue: 1,${ts(0.0)},${ts(7.0)},Badge,,0,0,0,,{\\pos(1860,60)}02 — TRANSPARENCY | AGENT MODE`,
  `Dialogue: 1,${ts(7.3)},${ts(15.5)},Badge,,0,0,0,,{\\pos(1860,60)}CONTEXT RETRIEVAL RECEIPT`,
  `Dialogue: 1,${ts(15.8)},${ts(34.0)},Badge,,0,0,0,,{\\pos(1860,60)}APPROVAL PAUSE & REVIEW`,
  `Dialogue: 1,${ts(34.3)},${ts(42.0)},Badge,,0,0,0,,{\\pos(1860,60)}SESSION COMPACTION`,
  `Dialogue: 1,${ts(42.3)},${ts(50.0)},Badge,,0,0,0,,{\\pos(1860,60)}AUTONOMOUS FILE DISCOVERY`,
  `Dialogue: 1,${ts(50.3)},${ts(57.0)},Badge,,0,0,0,,{\\pos(1860,60)}TRUEFORGE SESSION VISIBILITY`,
  `Dialogue: 1,${ts(57.3)},${ts(68.0)},Badge,,0,0,0,,{\\pos(1860,60)}TEST VERIFICATION`,
  `Dialogue: 1,${ts(68.3)},${ts(76.0)},Badge,,0,0,0,,{\\pos(1860,60)}CLI OUTPUT VERIFICATION`,
  `Dialogue: 1,${ts(76.3)},${ts(84.8)},Badge,,0,0,0,,{\\pos(1860,60)}MULTI-FILE ROLLBACK`,
  // Callouts (Layer 1, pos(1860,95))
  `Dialogue: 1,${ts(0.0)},${ts(7.0)},Callout,,0,0,0,,{\\pos(1860,95)}Prompt submitted: No files named`,
  `Dialogue: 1,${ts(7.3)},${ts(15.5)},Callout,,0,0,0,,{\\pos(1860,95)}Why these files? Git co-change & test pairing`,
  `Dialogue: 1,${ts(15.8)},${ts(34.0)},Callout,,0,0,0,,{\\pos(1860,95)}Staged edits in cli.py, test_cli.py, cli.rst`,
  `Dialogue: 1,${ts(34.3)},${ts(42.0)},Callout,,0,0,0,,{\\pos(1860,95)}Triggered at 12,000 tokens in TrueForge`,
  `Dialogue: 1,${ts(42.3)},${ts(50.0)},Callout,,0,0,0,,{\\pos(1860,95)}3 files discovered and modified unprompted`,
  `Dialogue: 1,${ts(50.3)},${ts(57.0)},Callout,,0,0,0,,{\\pos(1860,95)}Inspectable turns, tools & compact summaries`,
  `Dialogue: 1,${ts(57.3)},${ts(68.0)},Callout,,0,0,0,,{\\pos(1860,95)}pytest tests/test_cli.py -> 59 passed`,
  `Dialogue: 1,${ts(68.3)},${ts(76.0)},Callout,,0,0,0,,{\\pos(1860,95)}flask config prints masked JSON (***)`,
  `Dialogue: 1,${ts(76.3)},${ts(84.8)},Callout,,0,0,0,,{\\pos(1860,95)}Single undo reverts all 3 files together`,
  // Subtitle captions for spoken voiceover (Layer 0, bottom center)
  `Dialogue: 0,${ts(0.4)},${ts(7.5)},Cap,,0,0,0,,For complex engineering tasks, Ripple moves beyond single-file editing, discovering relevant files without requiring the developer to name each one.`,
  `Dialogue: 0,${ts(8.0)},${ts(15.5)},Cap,,0,0,0,,Its context receipt makes file selection inspectable: ranking files by git co-change, test pairing, and lexical evidence within a hard token budget.`,
  `Dialogue: 0,${ts(16.0)},${ts(22.0)},Cap,,0,0,0,,TrueForge approval pause opens each diff for review before anything is written.`,
  `Dialogue: 0,${ts(34.5)},${ts(40.0)},Cap,,0,0,0,,As the thread grows, TrueForge automatically compacts context into a concise summary.`,
  `Dialogue: 0,${ts(42.5)},${ts(48.0)},Cap,,0,0,0,,Done: the agent changed three files it found itself: cli.py, test_cli.py, and cli.rst.`,
  `Dialogue: 0,${ts(50.5)},${ts(56.5)},Cap,,0,0,0,,The underlying TrueForge session exposes every tool call, turn event, and compaction step inside VS Code.`,
  `Dialogue: 0,${ts(57.5)},${ts(66.0)},Cap,,0,0,0,,Verify: all fifty-nine CLI tests pass, and the new command prints masked JSON.`,
  `Dialogue: 0,${ts(76.5)},${ts(83.0)},Cap,,0,0,0,,A single undo reverts all three files together, leaving the repository completely clean.`
];
const durTaskB = buildSegmentVideo('task_b', taskBSegments, taskBEvents);

// -------------------------------------------------------------
// SEGMENT 4: TASK C (Resilience - Automatic Local Fallback)
// -------------------------------------------------------------
const taskCSegments = [
  { from: 352.84, to: 397.57, fast: false, speed: 1 }
];

const mapC = (rawT) => rawT - 352.84;

const taskCMasks = masks.map(m => ({
  ...m,
  from: mapC(m.from),
  to: mapC(m.to)
}));

// Strict non-overlapping schedule for Task C
const taskCEvents = [
  // Badges (Layer 1, pos(1860,60))
  `Dialogue: 1,${ts(0.0)},${ts(11.5)},Badge,,0,0,0,,{\\pos(1860,60)}03 — RESILIENCE | PROVIDER OUTAGE`,
  `Dialogue: 1,${ts(11.8)},${ts(24.0)},Badge,,0,0,0,,{\\pos(1860,60)}AUTOMATIC LOCAL FALLBACK`,
  `Dialogue: 1,${ts(24.3)},${ts(30.0)},Badge,,0,0,0,,{\\pos(1860,60)}LOCAL MODEL TAKES OVER`,
  `Dialogue: 1,${ts(30.3)},${ts(38.0)},Badge,,0,0,0,,{\\pos(1860,60)}WORKSPACE INTEGRITY PRESERVED`,
  `Dialogue: 1,${ts(38.3)},${ts(44.7)},Badge,,0,0,0,,{\\pos(1860,60)}REJECT & CLEAN STATE`,
  // Callouts (Layer 1, pos(1860,95))
  `Dialogue: 1,${ts(0.0)},${ts(11.5)},Callout,,0,0,0,,{\\pos(1860,95)}Simulating Gemini outage: endpoint stopped`,
  `Dialogue: 1,${ts(11.8)},${ts(24.0)},Callout,,0,0,0,,{\\pos(1860,95)}Primary failed (ECONNREFUSED) -> Routing to Ollama 7B`,
  `Dialogue: 1,${ts(24.3)},${ts(30.0)},Callout,,0,0,0,,{\\pos(1860,95)}Qwen 2.5 Coder 7B generates reviewable diff`,
  `Dialogue: 1,${ts(30.3)},${ts(38.0)},Callout,,0,0,0,,{\\pos(1860,95)}git status is clean while review is open`,
  `Dialogue: 1,${ts(38.3)},${ts(44.7)},Callout,,0,0,0,,{\\pos(1860,95)}Reject proposal: 0 files modified on disk`,
  // Subtitle captions for spoken voiceover (Layer 0, bottom center)
  `Dialogue: 0,${ts(0.4)},${ts(7.0)},Cap,,0,0,0,,Model failure should not mean workflow failure. We simulate an endpoint outage by disabling the primary Gemini service.`,
  `Dialogue: 0,${ts(11.8)},${ts(18.0)},Cap,,0,0,0,,When the primary model endpoint becomes unavailable, the adapter retries and switches to a local model.`,
  `Dialogue: 0,${ts(24.3)},${ts(30.0)},Cap,,0,0,0,,The local fallback model proposed the edit. The editor stayed completely responsive.`,
  `Dialogue: 0,${ts(30.3)},${ts(37.5)},Cap,,0,0,0,,While the review is open, nothing is on disk: git status is clean.`,
  `Dialogue: 0,${ts(38.3)},${ts(44.0)},Cap,,0,0,0,,Reject: the workspace stays unchanged.`
];
const durTaskC = buildSegmentVideo('task_c', taskCSegments, taskCEvents, taskCMasks);

console.log('--- Phase 3: Calculating Timeline & Narration Alignment ---');
const playlist = [
  { id: 'open_01', dur: 5.0 },
  { id: 'open_02', dur: 8.2 },
  { id: 'open_03', dur: 5.5 },
  { id: 'arch',    dur: 13.5 },
  { id: 'sec_01',  dur: 2.0 },
  { id: 'task_a',  dur: durTaskA },
  { id: 'cancel',  dur: durCancel },
  { id: 'sec_02',  dur: 2.5 },
  { id: 'task_b',  dur: durTaskB },
  { id: 'sec_03',  dur: 2.5 },
  { id: 'task_c',  dur: durTaskC },
  { id: 'closing', dur: 9.0 }
];

let currTime = 0;
const segStarts = {};
for (const item of playlist) {
  segStarts[item.id] = currTime;
  currTime += item.dur;
}
const totalDuration = currTime;
console.log(`Total Final Duration: ${totalDuration.toFixed(2)}s (${(totalDuration / 60).toFixed(2)} min)`);

// 100% Conflict-Free Audio Schedule
const audioCues = [
  // Opening: 3 distinct cards, 3 audio cues
  { file: 'v_open_01.wav', at: segStarts.open_01 + 0.1, tempo: 1.0 },
  { file: 'v_open_02.wav', at: segStarts.open_02 + 0.1, tempo: 1.0 },
  { file: 'v_open_03.wav', at: segStarts.open_03 + 0.1, tempo: 1.0 },
  // Architecture
  { file: 'v_arch.wav',    at: segStarts.arch + 0.1, tempo: 1.05 },
  // Task A: 4 cues
  { file: 'v_taskA_intro.wav',  at: segStarts.task_a + 0.4, tempo: 1.0 },
  { file: 'v_taskA_diff.wav',   at: segStarts.task_a + 19.8, tempo: 1.0 },
  { file: 'v_taskA_verify.wav', at: segStarts.task_a + 27.3, tempo: 1.0 },
  { file: 'v_taskA_undo.wav',   at: segStarts.task_a + 37.3, tempo: 1.0 },
  // Cancel
  { file: 'v_cancel.wav',       at: segStarts.cancel + 0.4, tempo: 1.0 },
  // Task B: perfectly spaced with zero overlap
  { file: 'v_taskB_intro.wav',   at: segStarts.task_b + 0.4, tempo: 1.0 },
  { file: 'v_taskB_receipt.wav', at: segStarts.task_b + 8.0, tempo: 1.0 },
  { file: 'v_taskB_review.wav',  at: segStarts.task_b + 16.5, tempo: 1.0 },
  { file: 'v_taskB_compact.wav', at: segStarts.task_b + 34.5, tempo: 1.0 },
  { file: 'v_taskB_verify.wav',  at: segStarts.task_b + 57.5, tempo: 1.0 },
  { file: 'v_taskB_undo.wav',    at: segStarts.task_b + 76.5, tempo: 1.0 },
  // Task C
  { file: 'v_taskC_intro.wav',    at: segStarts.task_c + 0.4, tempo: 1.0 },
  { file: 'v_taskC_fallback.wav', at: segStarts.task_c + 11.8, tempo: 1.0 },
  { file: 'v_taskC_review.wav',   at: segStarts.task_c + 30.3, tempo: 1.0 },
  // Closing
  { file: 'v_closing.wav',        at: segStarts.closing + 0.5, tempo: 1.0 }
];

// Audio Overlap Safety Verification Assertion
console.log('--- Verifying Audio Overlap Safety ---');
for (let i = 0; i < audioCues.length - 1; i++) {
  const c = audioCues[i];
  const dur = probe(path.join(out, c.file)) / c.tempo;
  const end = c.at + dur;
  const nextStart = audioCues[i + 1].at;
  if (end > nextStart) {
    throw new Error(`CRITICAL: Audio overlap between ${c.file} and ${audioCues[i+1].file} by ${(end - nextStart).toFixed(2)}s`);
  }
}
console.log('Zero audio overlap confirmed.');

console.log('--- Phase 4: Audio Mix & Master Video Concatenation ---');
const videoInputs = playlist.flatMap(p => ['-i', `${p.id}.mp4`]);
const videoConcat = playlist.map((_, idx) => `[${idx}:v]`).join('') + `concat=n=${playlist.length}:v=1:a=0[vout]`;

const audioInputs = audioCues.flatMap(c => ['-i', c.file]);
const audioFilters = audioCues.map((c, idx) => {
  const inIdx = playlist.length + idx;
  const tempoFilter = c.tempo > 1.001 ? `atempo=${c.tempo.toFixed(3)},` : '';
  const delayMs = Math.round(c.at * 1000);
  return `[${inIdx}:a]${tempoFilter}adelay=${delayMs}:all=1[a${idx}]`;
}).join(';');

const audioMix = audioCues.map((_, idx) => `[a${idx}]`).join('') + `amix=inputs=${audioCues.length}:normalize=0,apad,atrim=0:${totalDuration.toFixed(2)}[anarr]`;

const fullFilter = [
  videoConcat,
  audioFilters,
  audioMix,
  `aevalsrc=0.015*sin(2*PI*110*t)+0.01*sin(2*PI*164.81*t)+0.01*sin(2*PI*220*t):s=44100:d=${totalDuration.toFixed(2)}[amb_raw]`,
  `[amb_raw]lowpass=f=350,volume=0.25[a_amb]`,
  `[anarr][a_amb]amix=inputs=2:weights=1.0 0.15[aout]`
].join(';\n');

writeFileSync(path.join(out, 'master_filter.txt'), fullFilter, 'utf-8');

console.log('Rendering master video with 100% clean non-overlapping elements...');
ff([
  ...videoInputs,
  ...audioInputs,
  '-/filter_complex', 'master_filter.txt',
  '-map', '[vout]',
  '-map', '[aout]',
  '-c:v', 'libx264',
  '-preset', 'veryfast',
  '-crf', '19',
  '-pix_fmt', 'yuv420p',
  '-c:a', 'aac',
  '-b:a', '160k',
  '-movflags', '+faststart',
  'ripple-demo-competition.mp4'
]);

const finalProbe = probe(path.join(out, 'ripple-demo-competition.mp4'));
console.log(`\n===========================================`);
console.log(`MASTER VIDEO SUCCESSFUL!`);
console.log(`File: ${path.join(out, 'ripple-demo-competition.mp4')}`);
console.log(`Duration: ${finalProbe.toFixed(2)}s (${Math.floor(finalProbe / 60)}m ${(finalProbe % 60).toFixed(1)}s)`);
console.log(`===========================================`);
