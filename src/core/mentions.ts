// @file and @symbol mentions in a prompt. No `vscode` imports.
import { findSymbols, symbolBlock, type Pin, type RetrieveSource } from './retrieve';

export interface MentionResolution {
  pins: Pin[];
  /** Mentions that matched no file and no symbol. */
  unresolved: string[];
}

/** The @tokens of a prompt, without the @ and without trailing punctuation. */
export function parseMentions(text: string): string[] {
  const out: string[] = [];
  const re = /(?<![\w@.])@([A-Za-z0-9_$][A-Za-z0-9_$./\\-]*)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const token = (m[1] ?? '').replace(/[.,;:!?)\]]+$/, '').replace(/\\/g, '/');
    if (token && !out.includes(token)) out.push(token);
  }
  return out;
}

const CODE = /\.(py|pyi|[cm]?[jt]sx?|go|rs|java|kt|rb|php|cs|swift|c|h|cpp|hpp)$/i;
const MAX_SYMBOL_PINS = 3;
const MAX_SYMBOL_SCAN = 4000;

/**
 * Resolves mentions to pins. A mention is a file when it is a workspace path, or the end of
 * exactly one path (`@cli.py`, `@flask/cli.py`). Otherwise it is looked up as a symbol
 * definition (`@FlaskGroup`, `@Config.from_file`) and pins that definition's lines.
 */
export async function resolveMentions(mentions: string[], source: RetrieveSource): Promise<MentionResolution> {
  const pins: Pin[] = [];
  const unresolved: string[] = [];
  if (mentions.length === 0) return { pins, unresolved };
  const files = (await source.listFiles()).map((p) => p.replace(/\\/g, '/'));
  const symbols: string[] = [];
  for (const mention of mentions) {
    const label = `@${mention}`;
    const exact = files.find((f) => f === mention);
    const suffix = exact ? [exact] : files.filter((f) => f.endsWith(`/${mention}`));
    if (suffix.length === 1 && suffix[0]) pins.push({ path: suffix[0], label });
    else if (suffix.length > 1) {
      // Ambiguous file name: take the shortest path; the receipt shows which one was used.
      const pick = [...suffix].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
      if (pick) pins.push({ path: pick, label });
    } else if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(mention)) symbols.push(mention);
    else unresolved.push(label);
  }
  if (symbols.length) {
    const found = new Map<string, Pin[]>(symbols.map((s) => [s, []]));
    for (const path of files.filter((f) => CODE.test(f)).slice(0, MAX_SYMBOL_SCAN)) {
      let text: string;
      try {
        text = await source.readText(path);
      } catch {
        continue;
      }
      const wanted = symbols.filter((s) => text.includes(s.slice(s.lastIndexOf('.') + 1)));
      if (wanted.length === 0) continue;
      const lines = text.split(/\r?\n/);
      const defs = findSymbols(lines);
      for (const symbol of wanted) {
        const parts = symbol.split('.');
        const name = parts.at(-1);
        const owner = parts.length > 1 ? parts.at(-2) : undefined;
        for (const def of defs) {
          if (def.name !== name) continue;
          if (owner) {
            // `Owner.member`: the nearest less-indented definition above must be Owner.
            const parent = [...defs].reverse().find((d) => d.line < def.line && d.indent < def.indent);
            if (parent?.name !== owner) continue;
          }
          const block = symbolBlock(lines, def);
          found.get(symbol)?.push({ path, startLine: block.start + 1, endLine: block.end, label: `@${symbol}` });
        }
      }
    }
    for (const symbol of symbols) {
      const hits = found.get(symbol) ?? [];
      if (hits.length === 0) unresolved.push(`@${symbol}`);
      else pins.push(...hits.slice(0, MAX_SYMBOL_PINS));
    }
  }
  return { pins, unresolved };
}

/** One line per pin for the message sent to the agent. */
export function describePins(res: MentionResolution): string {
  const lines = res.pins.map((p) =>
    p.startLine === undefined ? `- ${p.label} → ${p.path}` : `- ${p.label} → ${p.path} lines ${p.startLine}-${p.endLine ?? p.startLine}`,
  );
  for (const u of res.unresolved) lines.push(`- ${u} → not found in the workspace`);
  return lines.join('\n');
}
