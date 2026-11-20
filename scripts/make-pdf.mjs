import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const mdPath = path.resolve('e:/ripples/docs/writeup.md');
const htmlPath = path.resolve('e:/ripples/docs/writeup.html');
const pdfPath = path.resolve('e:/ripples/docs/writeup.pdf');

const md = readFileSync(mdPath, 'utf-8');

function mdToHtml(text) {
  const lines = text.split('\n');
  let html = [];
  let inTable = false;
  let inList = false;

  for (let line of lines) {
    line = line.trim();
    if (!line) {
      if (inTable) { html.push('</tbody></table>'); inTable = false; }
      if (inList) { html.push('</ul>'); inList = false; }
      continue;
    }

    if (line.startsWith('# ')) {
      html.push(`<h1 class="title">${line.slice(2)}</h1>`);
    } else if (line.startsWith('## ')) {
      html.push(`<h2>${line.slice(3)}</h2>`);
    } else if (line.startsWith('### ')) {
      html.push(`<h3>${line.slice(4)}</h3>`);
    } else if (line.startsWith('- ')) {
      if (!inList) { html.push('<ul>'); inList = true; }
      let content = line.slice(2);
      content = content.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
      content = content.replace(/`(.*?)`/g, '<code>$1</code>');
      html.push(`<li>${content}</li>`);
    } else if (line.startsWith('|') && line.endsWith('|')) {
      if (inList) { html.push('</ul>'); inList = false; }
      if (line.includes('---')) continue;
      const cells = line.split('|').slice(1, -1).map(c => c.trim());
      if (!inTable) {
        html.push('<table><thead><tr>');
        cells.forEach(c => html.push(`<th>${c}</th>`));
        html.push('</tr></thead><tbody>');
        inTable = true;
      } else {
        html.push('<tr>');
        cells.forEach(c => {
          let cellHtml = c.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
          cellHtml = cellHtml.replace(/`(.*?)`/g, '<code>$1</code>');
          html.push(`<td>${cellHtml}</td>`);
        });
        html.push('</tr>');
      }
    } else {
      if (inTable) { html.push('</tbody></table>'); inTable = false; }
      if (inList) { html.push('</ul>'); inList = false; }
      let content = line.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
      content = content.replace(/`(.*?)`/g, '<code>$1</code>');
      content = content.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2">$1</a>');
      html.push(`<p>${content}</p>`);
    }
  }
  if (inTable) html.push('</tbody></table>');
  if (inList) html.push('</ul>');
  return html.join('\n');
}

const bodyContent = mdToHtml(md);

const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Ripple: an editor-native coding agent on TrueForge</title>
<style>
  @page {
    size: A4;
    margin: 14mm 15mm;
  }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 9.2pt;
    line-height: 1.42;
    color: #1a202c;
    background: #ffffff;
    margin: 0;
    padding: 0;
  }
  h1.title {
    font-size: 17pt;
    font-weight: 700;
    color: #0f172a;
    margin: 0 0 4px 0;
    padding-bottom: 4px;
    border-bottom: 2px solid #0284c7;
  }
  h2 {
    font-size: 11pt;
    font-weight: 700;
    color: #0f172a;
    margin: 10px 0 3px 0;
    border-bottom: 1px solid #e2e8f0;
    padding-bottom: 2px;
    page-break-after: avoid;
  }
  p {
    margin: 3px 0 5px 0;
    text-align: justify;
  }
  ul {
    margin: 3px 0 5px 0;
    padding-left: 18px;
  }
  li {
    margin-bottom: 2px;
    text-align: justify;
  }
  strong {
    color: #0f172a;
    font-weight: 600;
  }
  code {
    font-family: "Cascadia Code", Consolas, "Courier New", monospace;
    font-size: 8.4pt;
    background: #f1f5f9;
    padding: 1px 3px;
    border-radius: 3px;
    color: #0f172a;
    border: 1px solid #e2e8f0;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 5px 0 6px 0;
    font-size: 8.4pt;
    page-break-inside: avoid;
  }
  th {
    background: #f8fafc;
    color: #0f172a;
    font-weight: 600;
    text-align: left;
    padding: 4px 6px;
    border: 1px solid #cbd5e1;
  }
  td {
    padding: 3px 6px;
    border: 1px solid #cbd5e1;
    vertical-align: top;
  }
  tr:nth-child(even) td {
    background: #f8fafc;
  }
  a {
    color: #0284c7;
    text-decoration: none;
  }
</style>
</head>
<body>
${bodyContent}
</body>
</html>`;

writeFileSync(htmlPath, fullHtml, 'utf-8');
console.log(`Generated HTML: ${htmlPath}`);

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
execFileSync('cmd.exe', ['/c', edgePath, '--headless=new', '--disable-gpu', `--print-to-pdf=${pdfPath}`, `file:///${htmlPath.replace(/\\\\/g, '/')}`], { stdio: 'inherit' });

console.log(`\nGenerated PDF: ${pdfPath}`);
