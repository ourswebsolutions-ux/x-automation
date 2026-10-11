// Runs the unit suites in tests/unit on Electron's Node runtime (the same node:sqlite and
// safeStorage-free environment the main process uses, with `electron` stubbed).
//   node tests/run-unit.mjs            → every suite
//   node tests/run-unit.mjs pub runs   → only these (AXORA_TEST_VERBOSE=1 prints every line)
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import electronPath from 'electron'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const all = readdirSync(join(here, 'unit')).filter((f) => f.endsWith('.test.ts')).map((f) => f.replace('.test.ts', ''))
const wanted = process.argv.slice(2)
const suites = wanted.length ? all.filter((s) => wanted.includes(s)) : all
const work = mkdtempSync(join(tmpdir(), 'axora-unit-'))

// Fixtures: the small ones are in the repo; the large ones (size-limit checks) are made here by
// inserting comment (COM) segments into a real JPEG, so it stays a valid file with its real dimensions.
const fixtures = join(work, 'fixtures')
mkdirSync(fixtures)
for (const f of readdirSync(join(here, 'fixtures'))) copyFileSync(join(here, 'fixtures', f), join(fixtures, f))
const photo = readFileSync(join(here, 'fixtures', 'photo.jpg'))
const padded = (bytes) => {
  const segments = []
  for (let left = bytes; left > 0; left -= 65533) {
    const n = Math.min(left, 65533)
    const seg = Buffer.alloc(n + 4)
    seg.writeUInt16BE(0xfffe, 0)
    seg.writeUInt16BE(n + 2, 2)
    segments.push(seg)
  }
  return Buffer.concat([photo.subarray(0, 2), ...segments, photo.subarray(2)])
}
writeFileSync(join(fixtures, 'mid.jpg'), padded(6_120_000))
writeFileSync(join(fixtures, 'big.jpg'), padded(17_680_000))

let failed = 0
let total = 0
for (const suite of suites) {
  const dir = join(work, suite === 'backup' ? 'with space' : suite)
  mkdirSync(dir, { recursive: true })
  const out = join(dir, `${suite}.test.mjs`)
  await build({
    entryPoints: [join(here, 'unit', `${suite}.test.ts`)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: out,
    alias: { '@shared': join(root, 'src/shared'), electron: join(here, 'unit/electron-stub.mjs') },
    external: ['node:*'],
    logLevel: 'error'
  })
  const run = spawnSync(electronPath, [out, join(dir, `${suite}.db`)], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AXORA_TEST_HOME: join(dir, 'home'), AXORA_TEST_FIXTURES: fixtures },
    encoding: 'utf8',
    timeout: 300_000
  })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  const lines = output.split('\n')
  const fails = lines.filter((l) => l.startsWith('FAIL'))
  const count = lines.filter((l) => l.startsWith('PASS') || l.startsWith('FAIL')).length
  const ok = run.status === 0 && fails.length === 0 && count > 0
  total += count
  failed += fails.length + (ok || fails.length ? 0 : 1)
  console.log(`${ok ? '✓' : '✗'} ${suite.padEnd(9)} ${count - fails.length}/${count}`)
  if (process.env.AXORA_TEST_VERBOSE) console.log(output)
  else if (!ok) console.log(fails.length ? fails.join('\n') : output.split('\n').slice(-15).join('\n'))
}
rmSync(work, { recursive: true, force: true, maxRetries: 5 })
console.log(`\n${total - failed}/${total} checks passed in ${suites.length} suites`)
process.exit(failed ? 1 : 0)
