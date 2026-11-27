// Все проверки набора без Telegram: node tests/run.mjs
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
for (const file of ['kit.test.mjs', 'setup-sender.test.mjs', 'listener-shared.test.mjs', 'bridge.test.mjs', 'bridge-shared.test.mjs', 'bridge-routing.test.mjs', 'release-regressions.test.mjs', 'plugin.test.mjs', 'docs.test.mjs']) {
  const r = spawnSync(process.execPath, [resolve(HERE, file)], { encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
  const out = r.stdout || '';
  pass += (out.match(/^PASS/gm) || []).length;
  fail += (out.match(/^FAIL/gm) || []).length + (r.status === 0 ? 0 : 1);
  console.log(`== ${file}`);
  console.log(out.split('\n').filter((l) => /^(PASS|FAIL)/.test(l)).join('\n'));
  if (r.status !== 0) console.log((r.stderr || r.error?.message || 'Процесс завершился без успешного кода').slice(-4000));
}
console.log(`\nИтог: прошли ${pass}, не прошли ${fail}`);
process.exitCode = fail ? 1 : 0;
