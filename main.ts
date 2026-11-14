// The token radar's entrypoint: one sealed snapshot in, one ranked board and one dashboard out.
//
// The program reads the snapshot from /input/snapshot.json (or --input <file|dir>), scores every
// protocol the radar may rank with the model in lib/model.ts, writes /output/board.json and the
// page's /output/data.js, copies this repository's dashboard/ and screenshots/ beside them, and
// writes /output/dossier.json last with the vendored make.fun library, because the scorer rebuilds
// that file from this /output and compares it byte for byte.
//
// Nothing here reaches the network and nothing reads the clock: the board's order is a total order
// on the snapshot's own figures, so two runs of the program write the same bytes.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's caps: the text cap shapes the dossier's bytes, the rest only refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4_194_304 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const MIN_SCREENSHOTS = 3;

/** --name <value> or --name=<value> out of the arguments, else the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const joined = process.argv.find((a) => a.startsWith(`--${name}=`));
  return joined === undefined ? fallback : joined.slice(name.length + 3);
}

function fail(message: string): never {
  process.stderr.write(`token radar: ${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------- the snapshot

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);

// The program refuses its own board before writing it, so a board the gate would return never reaches
// the grader: the watchlist covered, ranks 1..n, implied values that never rise, farm steps in shape.
const issue = boardIssue(board, snapshot);
if (issue !== null) fail(`the model wrote a board the gate refuses: ${issue}`);

// ---------------------------------------------------------------- the board and the page's data

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

// ---------------------------------------------------------------- the page and its screenshots

/** Copy one directory's plain files into `to`, skipping dot files; the gate refuses the rest. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from).sort()) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const dashFiles = copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));

if (!dashFiles.includes('index.html')) fail('dashboard/ holds no index.html: the page is what the judge reads');
if (!dashFiles.some((n) => n.endsWith('.css')) || !dashFiles.some((n) => n.endsWith('.js'))) {
  fail('dashboard/ needs at least one .css and one .js file beside index.html');
}
if (shots.length < MIN_SCREENSHOTS) {
  fail(`screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in ${MIN_SCREENSHOTS}, the board, a protocol's detail view and a filtered view`);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) fail(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters, not starting with . or -`);
}

// ---------------------------------------------------------------- the dossier, written last

writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: DASHBOARD_CAPS }),
);

const dossierBytes = statSync(join(out, 'dossier.json')).size;
process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols in the snapshot, ${radar.counts.token_bearing} of them token-bearing, ` +
    `${radar.counts.watchlist} on the watchlist, ${board.length} rows ranked (${radar.counts.below_floor} below the floor)\n` +
    `token radar: wrote board.json, data.js, dashboard/ (${dashFiles.length} files), screenshots/ (${shots.length} images), dossier.json (${dossierBytes} bytes)\n`,
);
