const fs = require('fs');
const vpPath = 'src/lib/v4-predictor.ts';
const lines = fs.readFileSync(vpPath, 'utf8').split('\n');
console.log('Read', lines.length, 'lines');

const startIdx = lines.findIndex(l => l.includes('export interface XgHistoryMatch'));
if (startIdx < 0) { console.error('NO START'); process.exit(1); }
console.log('Start at line', startIdx + 1);

const bpIdx = lines.findIndex(l => l.includes('export function buildPredictions'));
if (bpIdx < 0) { console.error('NO BUILD'); process.exit(1); }
console.log('buildPredictions at line', bpIdx + 1);

let endIdx = bpIdx - 1;
while (endIdx > startIdx && (lines[endIdx].trim() === '' || lines[endIdx].trim().startsWith('*') || lines[endIdx].trim().startsWith('/*') || lines[endIdx].trim().startsWith('//'))) endIdx--;
if (!lines[endIdx].trim().startsWith('}')) { console.error('NO CLOSING BRACE at line', endIdx + 1); process.exit(1); }
console.log('Block end at line', endIdx + 1);

const block = lines.slice(startIdx, endIdx + 1).join('\n');

let adsStart = -1, adsEnd = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trim() === 'import {') {
    let j = i + 1, hasAD = false;
    while (j < lines.length && !lines[j].includes('} from')) { if (lines[j].includes('buildAttackDefenceTable')) hasAD = true; j++; }
    if (hasAD) { adsStart = i; adsEnd = j; break; }
  }
}
if (adsStart < 0) { console.error('NO ATTACKDEFENCE IMPORT'); process.exit(1); }
console.log('attackDefence import: lines', adsStart + 1, '-', adsEnd + 1);

let hmStart = -1;
for (let i = 0; i < lines.length; i++) { if (lines[i].includes('HistoricalMatch') && lines[i].includes('./data/historical')) { hmStart = i; break; } }
console.log('HistoricalMatch import:', hmStart >= 0 ? 'line ' + (hmStart + 1) : 'not found');

const out = [];
for (let i = 0; i < lines.length; i++) {
  if (i >= startIdx && i <= endIdx) continue;
  if (i >= adsStart && i <= adsEnd) continue;
  if (hmStart >= 0 && i === hmStart) continue;
  out.push(lines[i]);
}
const newContent = out.join('\n');
if (newContent.includes('from "./data/attackDefence"')) { console.error('FAIL: import still present'); process.exit(1); }

fs.writeFileSync(vpPath, newContent);
console.log('Wrote new', vpPath, '(', out.length, 'lines )');

const header = `// V4 Predictor — Server-only xG resolver. Do not import from client components.
import {
  buildAttackDefenceTable,
  computeMatchExpectedGoals,
  type AttackDefenceTable,
} from "./data/attackDefence";
import type { HistoricalMatch } from "./data/historical";
import {
  CHAOS_TEAMS,
  TOP_4,
  MID_TABLE,
  BOTTOM_5,
  translateTeamName,
  type MatchXgResolver,
} from "./v4-predictor";

`;
fs.writeFileSync('src/lib/v4-predictor-server.ts', header + block + '\n');
console.log('Wrote src/lib/v4-predictor-server.ts');

const callers = ['src/app/api/v4-predictor/auto/route.ts', 'scripts/backtest-local.ts', 'src/lib/v4-predictor.test.ts'];
for (const file of callers) {
  let content = fs.readFileSync(file, 'utf8');
  const before = content;
  content = content.replace(/import\s*\{([^}]*)\}\s*from\s*["']([^"']*\/v4-predictor)["']/g, (m, names, path) => {
    if (!names.includes('createMatchXgResolver')) return m;
    const cleaned = names.split(',').map(n => n.trim()).filter(n => n && n !== 'createMatchXgResolver');
    const serverPath = path.replace(/\/v4-predictor$/, '/v4-predictor-server');
    const parts = [];
    if (cleaned.length) parts.push(`import { ${cleaned.join(', ')} } from "${path}";`);
    parts.push(`import { createMatchXgResolver } from "${serverPath}";`);
    return parts.join('\n');
  });
  if (content !== before) { fs.writeFileSync(file, content); console.log('Updated', file); }
  else console.log('No change to', file);
}
console.log('DONE');
