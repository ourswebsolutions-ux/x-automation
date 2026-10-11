// Phase 12 end-to-end: AI automation runs in the real Electron app + real Python engine + real Chrome
// (three headless Chromes stand in for three IX profiles' browsers, reached over CDP) + the local X
// stand-in (engine/tests/x_fixture.py). IX Browser and OpenAI are contract MOCKS. x.com is NOT contacted.
// Needs `npm run build` first (the app is launched from out/), Google Chrome at /usr/bin/google-chrome
// (or CHROME_PATH), and the bundled engine runtime (engine-runtime/<platform>).
//   node tests/e2e/automation.e2e.mjs        screenshots → $AXORA_TEST_SHOTS (default: a temp folder)
import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { startMock } from '../mocks/ixmock.mjs'
import { startOpenAiMock, VALID_KEY } from '../mocks/openaimock.mjs'

const project = join(dirname(fileURLToPath(import.meta.url)), '../..')
const work = mkdtempSync(join(tmpdir(), 'axora-e2e-'))
const home = join(work, 'home')
const shots = process.env.AXORA_TEST_SHOTS ?? join(work, 'shots')
for (const d of [home, shots]) { rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }) }
const results = []
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? ' — ' + String(extra).slice(0, 300) : ''}`)
const problems = []
const cleanups = []
let app, page
const finish = (code) => { cleanups.forEach((c) => { try { c() } catch {} }); setTimeout(() => { if (!process.env.AXORA_TEST_SHOTS) rmSync(work, { recursive: true, force: true, maxRetries: 5 }); process.exit(code) }, 1500) }
const bail = (e) => { console.log(results.join('\n')); console.log('CRASH', String(e?.stack ?? e).split('\n').slice(0, 8).join(' | ')); finish(1) }
process.on('uncaughtException', bail)
process.on('unhandledRejection', bail)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return true } catch {} await sleep(250) } return false }

// ── three real browsers, one per IX profile, each "signed in" to its own account on the X stand-in ──
const python = process.platform === 'win32' ? join(project, 'engine-runtime/win/python/python.exe') : join(project, 'engine-runtime/linux/python/bin/python3')
const fx = spawn(python, ['-I', '-u', `${project}/engine/tests/x_fixture.py`], { stdio: ['pipe', 'pipe', 'inherit'] })
cleanups.push(() => fx.kill('SIGKILL'))
const fxPort = await new Promise((resolve) => createInterface({ input: fx.stdout }).once('line', (l) => resolve(JSON.parse(l).port)))
const fxBase = `http://127.0.0.1:${fxPort}`
const fxSet = (mode) => fetch(`${fxBase}/__control`, { method: 'POST', body: JSON.stringify({ mode }) })
const fxPosts = async () => (await fetch(`${fxBase}/__posts`)).json()

const HANDLES = ['relay_a', 'relay_b', 'relay_c']
const chromes = []
for (const handle of HANDLES) {
  const port = 9300 + Math.floor(Math.random() * 600)
  const dir = mkdtempSync(join(tmpdir(), 'axora-p12-'))
  const proc = spawn(process.env.CHROME_PATH ?? '/usr/bin/google-chrome', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' })
  cleanups.push(() => { proc.kill('SIGKILL'); setTimeout(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }), 500) })
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok)
  // The stand-in reads the signed-in handle from an `xh` cookie (set through the documented CDP Storage domain).
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(webSocketDebuggerUrl)
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Storage.setCookies', params: { cookies: [{ name: 'xh', value: handle, domain: '127.0.0.1', path: '/', expires: Date.now() / 1000 + 86400 }] } }))
    ws.onmessage = (m) => { const r = JSON.parse(m.data); if (r.id === 1) { ws.close(); r.error ? reject(new Error(r.error.message)) : resolve() } }
    ws.onerror = () => reject(new Error('CDP connection failed'))
  })
  chromes.push({ handle, port })
}

// ── IX Browser (mock): 5 profiles; 1–3 open the three browsers ──
const ix = await startMock()
cleanups.push(() => ix.close())
ix.state.profiles = ix.state.profiles.slice(0, 5)
ix.state.debuggingAddress = `127.0.0.1:${chromes[0].port}`
chromes.forEach((c, i) => (ix.state.debuggingAddresses[i + 1] = `127.0.0.1:${c.port}`))

// ── OpenAI (mock): every generated text differs ──
const ai = await startOpenAiMock()
cleanups.push(() => ai.close())
ai.state.unique = true

async function launch() {
  const env = { ...process.env, XDG_CONFIG_HOME: home, AXORA_TEST_X_BASE_URL: fxBase, AXORA_TEST_QUEUE_BACKOFF_MS: '400' }
  delete env.ELECTRON_RUN_AS_NODE
  const a = await electron.launch({ executablePath: electronPath, args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', project], env, cwd: project })
  const p = await a.firstWindow()
  p.on('console', (m) => ['error', 'warning'].includes(m.type()) && problems.push(`[${m.type()}] after "${results.at(-1)?.slice(6, 60)}": ${m.text().slice(0, 160)}`))
  p.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`))
  await p.waitForSelector('h1', { timeout: 20000 })
  await a.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1480, 1000))
  return { a, p }
}
const snap = async (name) => {
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.invalidate())
    await page.waitForTimeout(300)
    const b64 = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
    writeFileSync(`${shots}/${name}.png`, Buffer.from(b64, 'base64'))
  } catch (e) { console.log(`(screenshot ${name} skipped: ${e.message.split('\n')[0]})`) }
}
const go = async (hash) => { await page.evaluate((h) => (window.location.hash = h), hash); await page.waitForTimeout(700) }
const toastShown = (text, ms = 30000) => waitFor(async () => (await page.locator('[role="status"]', { hasText: text }).count()) > 0, ms)
const details = (id) => page.evaluate((i) => window.relay.runs.details(i), id)
const runSettled = (id, ms = 120000) => waitFor(async () => ['completed', 'stopped', 'failed'].includes((await details(id)).run.status), ms)
const summary = page_ => page_.locator('aside[aria-label="Summary"]')
const runPanel = () => page.locator('section[aria-label="Automation run"]')

const baseConfig = (patch = {}) => {
  const c = {
    name: 'Test run',
    mode: 'full-auto',
    content: { prompt: 'Short practical tips for developers', topic: 'keyboard shortcuts', language: 'English', tone: 'professional', length: 'short', hashtags: [], suggestHashtags: false, instructions: '', generateText: true, textProviderId: null, textModel: null, fixedText: '', generateImages: false, imageProviderId: null, imageModel: null, imageStyle: 'illustration', imageSize: '1024x1024', existingAssetId: null },
    targets: { scope: 'all', profileIds: [], distribution: 'unique', allowDuplicates: false, requireConfirmedIdentity: true, createMissingAccounts: false },
    actions: { publish: true, saveDrafts: false, repost: false, comment: false, like: false, engagementLinks: [], commentText: '' },
    schedule: { when: 'now', startAt: null, endAt: null, intervalMinutes: 0, postsPerProfile: 1, maxPostsPerRun: 20, workingHours: { enabled: false, start: '09:00', end: '18:00' } },
    failure: { generationRetries: 1, onTextFailure: 'skip', onImageFailure: 'pause', onProfileUnavailable: 'skip', stopAfterFailures: 3 }
  }
  for (const [k, v] of Object.entries(patch)) c[k] = typeof v === 'object' && !Array.isArray(v) && v !== null && typeof c[k] === 'object' ? { ...c[k], ...v } : v
  return c
}

// ── setup ──
;({ a: app, p: page } = await launch())
await page.evaluate(() => window.relay.preferences.update({ showDemoData: false }))
const info = await page.evaluate(() => window.relay.database.info())
check('schema v12 applied (automation_schedules included)', info.schemaVersion === 12 && info.migrations.at(-1).name === 'automation_schedules')
await page.evaluate((e) => window.relay.providers.create({ kind: 'ixbrowser', name: 'IX (mock)', endpoint: e, model: null, enabled: true }), `http://127.0.0.1:${ix.port}`)
await page.evaluate(() => window.relay.ixbrowser.sync())
let profiles = await page.evaluate(() => window.relay.ixbrowser.profiles())
const prof = (n) => profiles.find((p) => p.externalId === n)
const acc = []
for (let i = 0; i < 3; i++) acc.push(await page.evaluate(([pid, h]) => window.relay.accounts.create({ label: `Brand ${h}`, handle: h, confirmIdentity: true, notes: '', enabled: true, profileId: pid }), [prof(i + 1).id, HANDLES[i]]))
await page.evaluate((pid) => window.relay.accounts.create({ label: 'Unconfirmed', handle: null, confirmIdentity: false, notes: '', enabled: true, profileId: pid }), prof(4).id)
// Profile 5 disappears from IX Browser → unavailable after the next sync.
ix.state.profiles = ix.state.profiles.slice(0, 4)
await page.evaluate(() => window.relay.ixbrowser.sync())
profiles = await page.evaluate(() => window.relay.ixbrowser.profiles())
const textProv = await page.evaluate((e) => window.relay.providers.create({ kind: 'openai-compatible', adapter: 'openai', name: 'Mock OpenAI', endpoint: e, model: 'gpt-test-mini', enabled: true }), `http://127.0.0.1:${ai.port}/v1`)
await page.evaluate(({ id, k }) => window.relay.providers.setKey(id, k), { id: textProv.id, k: VALID_KEY })
const imgProv = await page.evaluate((e) => window.relay.providers.create({ kind: 'image', adapter: 'openai-images', name: 'Mock Images', endpoint: e, model: 'gpt-image-test', enabled: true }), `http://127.0.0.1:${ai.port}/v1`)
await page.evaluate(({ id, k }) => window.relay.providers.setKey(id, k), { id: imgProv.id, k: VALID_KEY })
await page.evaluate(([t, i]) => window.relay.preferences.update({ defaults: { textProviderId: t, imageProviderId: i } }), [textProv.id, imgProv.id])
await page.evaluate(() => window.relay.publishing.updateSettings({ spacingMinutes: 0 }))
check('setup: 5 profiles (1 unavailable), 3 confirmed accounts, 1 unconfirmed', profiles.length === 5 && profiles.filter((p) => p.availability === 'available').length === 4 && acc.every((a) => a.identity === 'confirmed'), profiles.map((p) => p.availability).join())

// ── 1. Full Auto through the wizard (default mode, All Profiles, text + images) ──
await page.evaluate(() => localStorage.removeItem('axora.automation.draft'))
await go('#/automation')
await page.waitForSelector('#auto-prompt')
check('wizard: Full Auto is the default mode', (await page.locator('[role="radio"][aria-checked="true"]:has-text("Full Auto")').count()) === 1)
check('wizard: All profiles by default, with counts', (await page.locator('[role="radio"][aria-checked="true"]:has-text("All profiles")').count()) === 1 && (await page.getByText('5 selected · 4 available · 1 unavailable').isVisible()))
await page.locator('#auto-name').fill('Keyboard tips')
await page.locator('#auto-prompt').fill('Short practical tips for developers. Original, no invented statistics.')
await page.locator('#auto-topic').fill('keyboard shortcuts')
await page.locator('[role="switch"][aria-label="Generate an image for each post"]').click()
check('plan: 3 of 5 profiles eligible, 3 posts, 3 images', await waitFor(async () => (await summary(page).innerText()).includes('3 of 5') && (await summary(page).locator('dd', { hasText: /^3$/ }).count()) >= 2, 8000), await summary(page).innerText().catch(() => ''))
const planText = await summary(page).innerText()
check('plan: unavailable and unconfirmed profiles left out, with warnings', planText.includes('1 profile is unavailable and will be left out') && planText.includes('1 account has no confirmed X username'), planText.replace(/\n/g, ' | '))
check('plan: enabled actions summarised', planText.includes('Publish automatically (Full Auto)') && planText.includes('Generate and attach an image per post') && !/repost|like/i.test(planText))
await snap('01-wizard')

// Save as preset (reused from the dashboard later)
await page.locator('main button:has-text("Save as preset")').click()
await page.locator('#preset-name').fill('Keyboard tips preset')
await page.locator('[role="dialog"] button:has-text("Save preset")').click()
check('preset saved', await toastShown('Preset saved', 8000))

const postsBefore1 = (await fxPosts()).length
await page.locator('aside[aria-label="Summary"] button:has-text("Start automation")').click()
const modal = page.locator('[role="dialog"]').last()
await modal.waitFor()
check('one confirmation before the run, describing it', (await modal.innerText()).includes('3 posts on 3 profiles, each with a generated image') && (await modal.innerText()).includes('without asking again'), (await modal.innerText()).replace(/\n/g, ' | '))
await snap('02-confirm')
await modal.locator('button:has-text("Start")').last().click()
check('“Automation started” notice', await toastShown('Automation started'))
let run1 = await page.evaluate(() => window.relay.runs.active())
check('run created in Full Auto', run1?.mode === 'full-auto' && run1.counts.total === 3)
await modal.waitFor({ state: 'detached', timeout: 10000 }).catch(() => {})
let maxDialogs = 0
const published1 = await waitFor(async () => {
  maxDialogs = Math.max(maxDialogs, await page.locator('[role="dialog"]').count())
  return (await fxPosts()).length - postsBefore1 >= 3 && (await details(run1.id)).run.status === 'completed'
}, 180000)
await snap('03-run-finished')
const posts1 = (await fxPosts()).slice(postsBefore1)
const d1 = await details(run1.id)
check('Full Auto: 3 posts published with no per-post confirmation', published1 && posts1.length === 3 && maxDialogs === 0, `posts=${posts1.length} dialogs=${maxDialogs} status=${d1.run.status}`)
check('… one per account, each from its own profile browser', HANDLES.every((h) => posts1.filter((p) => p.handle === h).length === 1), JSON.stringify(posts1.map((p) => p.handle)))
check('… all texts generated and different', new Set(posts1.map((p) => p.text)).size === 3 && posts1.every((p) => p.text.startsWith('Idea #')), JSON.stringify(posts1.map((p) => p.text)))
check('… every post carried its generated image', posts1.every((p) => p.files === 1), JSON.stringify(posts1.map((p) => p.files)))
check('run items: published, image attached, verified post link', d1.items.length === 3 && d1.items.every((i) => i.scheduleStatus === 'completed' && i.image === 'attached' && i.imageAssetId && /^https:\/\/x\.com\/relay_[abc]\/status\/\d+$/.test(i.postUrl ?? '')), JSON.stringify(d1.items.map((i) => [i.status, i.scheduleStatus, i.image, i.postUrl])))
check('… each link matches the post the stand-in received', d1.items.every((i) => posts1.some((p) => i.postUrl === `https://x.com/${p.handle}/status/${p.id}`)))
check('run counts: 3 published', d1.run.counts.published === 3 && d1.run.status === 'completed')
const assets1 = await page.evaluate(() => window.relay.assets.list())
check('generated images saved in the library', d1.items.every((i) => assets1.some((a) => a.id === i.imageAssetId && a.origin === 'generated' && a.available)))
const links1 = await page.evaluate(() => window.relay.links.list())
check('post links recorded', d1.items.every((i) => links1.some((l) => l.url === i.postUrl)))
check('IX: only the eligible profiles were opened', [1, 2, 3].every((n) => ix.state.log.some((l) => l.url === '/api/v2/profile-open' && l.params.profile_id === n)) && !ix.state.log.some((l) => l.url === '/api/v2/profile-open' && [4, 5].includes(l.params.profile_id)))
const ixCalls = (n) => ix.state.log.map((l, i) => ({ i, url: l.url, id: l.params?.profile_id })).filter((l) => l.id === n)
check('IX lifecycle: each profile opened only when its post was due and closed after it (open → close, nothing left open)', [1, 2, 3].every((n) => { const c = ixCalls(n); const lastOpen = c.filter((x) => x.url === '/api/v2/profile-open').at(-1)?.i ?? -1; const lastClose = c.filter((x) => x.url === '/api/v2/profile-close').at(-1)?.i ?? -1; return lastOpen >= 0 && lastClose > lastOpen }) && [1, 2, 3].every((n) => !ix.state.openedApi.has(n)), JSON.stringify([...ix.state.openedApi]))
check('image request went to the image endpoint with the chosen model', ai.state.log.filter((l) => l.path === '/v1/images/generations' && l.body?.model === 'gpt-image-test').length === 3)
check('“Post published” and “Automation finished” notices', (await toastShown('Post published')) && (await toastShown('Automation finished')))
check('run panel shows Finished and View on X links', (await runPanel().getByText('Finished').isVisible()) && (await runPanel().locator('button[aria-label="View on X"]').count()) === 3)

// ── 2. Manual Approval: approve, edit, regenerate, remove (Selected Profiles) ──
const postsBefore2 = (await fxPosts()).length
const run2 = await page.evaluate((c) => window.relay.runs.start(c), baseConfig({ name: 'Approval run', mode: 'manual-approval', targets: { scope: 'selected', profileIds: [prof(1).id, prof(2).id] }, schedule: { postsPerProfile: 2 } }))
check('Manual Approval: 4 posts generated and waiting', await waitFor(async () => (await details(run2.id)).run.counts.awaitingApproval === 4, 60000), JSON.stringify((await details(run2.id)).run.counts))
await sleep(2500)
check('… nothing published before approval', (await fxPosts()).length === postsBefore2)
check('… only the selected profiles are used', (await details(run2.id)).items.every((i) => [prof(1).id, prof(2).id].includes(i.profileId)))
check('“ready for your approval” notice', await toastShown('ready for your approval'))
await go(`#/automation?run=${run2.id}`)
await runPanel().waitFor()
await snap('04-approval')
let items2 = (await details(run2.id)).items
const [iRegen, iRemove, iEdit, iApprove] = items2
const rows = () => runPanel().locator('ul[aria-label="Posts in this run"] > li')
const rowOf = (text) => rows().filter({ hasText: text })
// regenerate
await rowOf(iRegen.text).locator('button[aria-label="Regenerate"]').click()
check('regenerate: new text replaces the old', await waitFor(async () => { const i = (await details(run2.id)).items.find((x) => x.id === iRegen.id); return i.status === 'awaiting-approval' && i.text && i.text !== iRegen.text }, 30000))
const regenText = (await details(run2.id)).items.find((x) => x.id === iRegen.id).text
// remove
await rowOf(iRemove.text).locator('button[aria-label="Remove"]').click()
check('remove: item removed from the run', await waitFor(async () => (await details(run2.id)).items.find((x) => x.id === iRemove.id).status === 'removed', 10000))
// edit in the editor
await rowOf(iEdit.text).locator('button[aria-label="Edit"]').click()
await page.waitForSelector('main textarea[aria-label="Post text"]')
const editedText = 'Edited by hand: Ctrl+Shift+P opens the command palette.'
await page.locator('main textarea[aria-label="Post text"]').fill(editedText)
await page.keyboard.press('Control+s'); await page.waitForTimeout(800)
await go(`#/automation?run=${run2.id}`)
await runPanel().waitFor()
check('edit: the run shows the edited text', await waitFor(async () => (await runPanel().innerText()).includes(editedText), 8000))
// approve one, then approve the rest at once
await rowOf(iApprove.text).locator('button:has-text("Approve")').click()
check('approve one', await waitFor(async () => (await details(run2.id)).items.find((x) => x.id === iApprove.id).status === 'scheduled', 10000))
await runPanel().locator('button:has-text("Approve all 2")').click()
check('approved posts publish', await waitFor(async () => (await fxPosts()).length - postsBefore2 >= 3 && (await details(run2.id)).run.status === 'completed', 120000), JSON.stringify((await details(run2.id)).run.counts))
const posts2 = (await fxPosts()).slice(postsBefore2)
check('… exactly the approved texts went out (edited, regenerated, approved; not removed)', posts2.length === 3 && posts2.some((p) => p.text === editedText) && posts2.some((p) => p.text === regenText) && posts2.some((p) => p.text === iApprove.text) && !posts2.some((p) => p.text === iRemove.text), JSON.stringify(posts2.map((p) => p.text)))
check('… only from the selected profiles’ accounts', posts2.every((p) => ['relay_a', 'relay_b'].includes(p.handle)))
const removedDraft = (await page.evaluate(() => window.relay.drafts.list())).find((d) => d.id === iRemove.draftId)
check('removed post kept as a draft, never published', !removedDraft || removedDraft.status !== 'published')
await snap('05-approval-done')

// ── 3. Pause, resume, stop ──
ai.state.latency = 1500
const postsBefore3 = (await fxPosts()).length
const run3 = await page.evaluate((c) => window.relay.runs.start(c), baseConfig({ name: 'Pause run', targets: { scope: 'selected', profileIds: [prof(1).id] }, schedule: { postsPerProfile: 3, intervalMinutes: 60 } }))
await page.evaluate((id) => window.relay.runs.pause(id), run3.id)
check('pause: run paused', (await details(run3.id)).run.status === 'paused')
check('“Automation paused” notice', await toastShown('Automation paused'))
await sleep(4000)
check('… nothing published while paused', (await fxPosts()).length === postsBefore3)
ai.state.latency = 0
await page.evaluate((id) => window.relay.runs.resume(id), run3.id)
check('resume: first post published', await waitFor(async () => (await fxPosts()).length - postsBefore3 === 1, 90000))
check('… the next two wait for their time slots', await waitFor(async () => (await details(run3.id)).items.filter((i) => i.scheduleStatus === 'pending').length === 2, 30000), JSON.stringify((await details(run3.id)).items.map((i) => [i.status, i.scheduleStatus])))
await go(`#/automation?run=${run3.id}`)
await runPanel().locator('button:has-text("Stop")').click()
await page.locator('[role="dialog"] button:has-text("Stop")').last().click()
check('stop: run stopped', await waitFor(async () => (await details(run3.id)).run.status === 'stopped', 10000))
check('“Automation stopped” notice says what happened', await toastShown('Automation stopped'))
const d3 = await details(run3.id)
check('… waiting posts cancelled, returned to drafts (not deleted)', d3.items.filter((i) => i.scheduleStatus === 'cancelled').length === 2 && (await page.evaluate(() => window.relay.drafts.list())).filter((d) => d3.items.some((i) => i.draftId === d.id && i.scheduleStatus === 'cancelled')).length === 2, JSON.stringify(d3.items.map((i) => i.scheduleStatus)))
await sleep(2000)
check('… nothing more published', (await fxPosts()).length - postsBefore3 === 1)

// ── 4. Restart recovery + mode switch (Manual → Full Auto approves what's waiting) ──
const run4 = await page.evaluate((c) => window.relay.runs.start(c), baseConfig({ name: 'Restart run', mode: 'manual-approval', targets: { scope: 'selected', profileIds: [prof(3).id] } }))
check('waiting for approval before restart', await waitFor(async () => (await details(run4.id)).run.counts.awaitingApproval === 1, 60000))
const before4 = (await details(run4.id)).items[0]
await app.close()
;({ a: app, p: page } = await launch())
const after4 = await details(run4.id)
check('after restart: run and its waiting post are still there', after4.run.status === 'awaiting-approval' && after4.items.length === 1 && after4.items[0].text === before4.text && after4.items[0].status === 'awaiting-approval')
const postsBefore4 = (await fxPosts()).length
await go(`#/automation?run=${run4.id}`)
await runPanel().waitFor()
await runPanel().locator('[role="radio"]:has-text("Full Auto")').click()
check('switching to Full Auto publishes the waiting post', await waitFor(async () => (await fxPosts()).length - postsBefore4 === 1 && (await details(run4.id)).run.status === 'completed', 90000))
const d4 = await details(run4.id)
check('… nothing deleted; mode recorded', d4.run.mode === 'full-auto' && d4.items.length === 1 && (await fxPosts()).at(-1).text === before4.text && (await fxPosts()).at(-1).handle === 'relay_c')

// ── 5. Unconfirmed outcome → profile check before any retry ──
await fxSet('silent')
const postsBefore5 = (await fxPosts()).length
const run5 = await page.evaluate((c) => window.relay.runs.start(c), baseConfig({ name: 'Silent run', targets: { scope: 'selected', profileIds: [prof(2).id] } }))
check('no confirmation shown → found on the profile → published', await waitFor(async () => (await details(run5.id)).run.status === 'completed', 150000), JSON.stringify((await details(run5.id)).items.map((i) => [i.scheduleStatus, i.error])))
const d5 = await details(run5.id)
const t5 = (await page.evaluate(() => window.relay.queue.list({ view: 'all' }))).find((t) => t.draftId === d5.items[0].draftId)
check('… verified by profile check, one submission only', t5?.status === 'succeeded' && t5.result?.verifiedBy === 'profile-check' && (await fxPosts()).length - postsBefore5 === 1 && d5.items[0].postUrl === `https://x.com/relay_b/status/${(await fxPosts()).at(-1).id}`, JSON.stringify(t5?.result))
await fxSet('silent-missing')
const postsBefore5b = (await fxPosts()).length
const run5b = await page.evaluate((c) => window.relay.runs.start(c), baseConfig({ name: 'Missing run', targets: { scope: 'selected', profileIds: [prof(2).id] } }))
check('not found on the profile → needs review (not retried)', await waitFor(async () => (await details(run5b.id)).items[0]?.scheduleStatus === 'needs-review', 150000), JSON.stringify((await details(run5b.id)).items.map((i) => i.scheduleStatus)))
check('“Publishing outcome needs review” notice', await toastShown('Publishing outcome needs review'))
await sleep(3000)
check('… exactly one submission', (await fxPosts()).length - postsBefore5b === 1)
await fxSet('ok')

// ── 6. Engagement only when enabled: planned for the user, never performed ──
const engBefore = await page.evaluate(() => window.relay.engagement.list({ status: 'all' }))
const postsBefore6 = (await fxPosts()).length
const ixOpensBefore = ix.state.log.filter((l) => l.url === '/api/v2/profile-open').length
const run6 = await page.evaluate((c) => window.relay.runs.start(c), baseConfig({ name: 'Like run', targets: { scope: 'selected', profileIds: [prof(1).id] }, actions: { publish: false, like: true, engagementLinks: ['https://x.com/someone_else/status/1234567890123456789'] } }))
check('engagement run finishes', await runSettled(run6.id, 30000), (await details(run6.id)).run.status)
const engAfter = await page.evaluate(() => window.relay.engagement.list({ status: 'all' }))
const newEng = engAfter.filter((e) => !engBefore.some((b) => b.id === e.id))
check('one like task planned for the user (no repost/comment tasks)', newEng.length === 1 && newEng[0].kind === 'like' && newEng[0].status === 'open', JSON.stringify(newEng.map((e) => [e.kind, e.status])))
check('… nothing published and no profile opened by the app', (await fxPosts()).length === postsBefore6 && ix.state.log.filter((l) => l.url === '/api/v2/profile-open').length === ixOpensBefore)

// ── 7. Image failure policy: publish without image only when chosen ──
ai.state.mode = 'img-garbage'
const postsBefore7 = (await fxPosts()).length
const run7 = await page.evaluate((c) => window.relay.runs.start(c), baseConfig({ name: 'No image run', content: { generateImages: true }, targets: { scope: 'selected', profileIds: [prof(3).id] }, failure: { onImageFailure: 'without-image' } }))
check('image failed → published without image (as chosen)', await waitFor(async () => (await details(run7.id)).run.status === 'completed', 120000))
const d7 = await details(run7.id)
check('… item says “no image”, post had no file', d7.items[0].image === 'skipped' && !d7.items[0].imageAssetId && (await fxPosts()).slice(postsBefore7)[0]?.files === 0)
const run7b = await page.evaluate((c) => window.relay.runs.start(c), baseConfig({ name: 'Pause on image', content: { generateImages: true }, targets: { scope: 'selected', profileIds: [prof(3).id] }, failure: { onImageFailure: 'pause' } }))
check('image failed with “pause” policy → run paused, nothing published', await waitFor(async () => (await details(run7b.id)).run.status === 'paused', 60000) && (await fxPosts()).length === postsBefore7 + 1)
check('… and no image is claimed', (await details(run7b.id)).items.every((i) => i.image !== 'attached'))
ai.state.mode = 'ok'
await page.evaluate((id) => window.relay.runs.stop(id), run7b.id)

// ── 8. Dashboard: automation panel, preset quick start, notifications ──
await go('#/')
await page.waitForSelector('section[aria-label="Automation"]')
const panel = page.locator('section[aria-label="Automation"]')
check('dashboard: Create automation and the saved preset', (await panel.locator('button:has-text("Create automation")').isVisible()) && (await panel.locator('button:has-text("Keyboard tips preset")').isVisible()))
check('dashboard: AI usage today from recorded requests', /[\d,]+ requests · [\d,]+ tokens · [\d,]+ images/.test(await panel.innerText()), await panel.innerText())
check('dashboard: recent notifications listed', (await panel.locator('button').filter({ hasText: /Automation|Post|Publishing/ }).count()) >= 1)
await snap('06-dashboard')
await page.evaluate(() => localStorage.removeItem('axora.automation.draft'))
await panel.locator('button:has-text("Keyboard tips preset")').click()
check('preset quick start loads the saved settings', await waitFor(async () => (await page.locator('#auto-prompt').inputValue()).startsWith('Short practical tips for developers. Original') && (await page.locator('[role="switch"][aria-label="Generate an image for each post"]').getAttribute('aria-checked')) === 'true', 8000))

// Selected profiles UI
await page.locator('[role="radio"]:has-text("Selected profiles")').click()
await page.waitForTimeout(300)
await page.getByRole('button', { name: 'Select all', exact: true }).click()
check('selected profiles: Select all → counts', await page.getByText('5 selected · 4 available · 1 unavailable').isVisible())
await page.getByRole('button', { name: 'Deselect all', exact: true }).click()
await page.locator(`[aria-label="Select ${prof(2).name}"]`).click()
check('… one picked → plan uses only that profile', await waitFor(async () => (await page.getByText('1 selected · 1 available · 0 unavailable').isVisible()) && (await summary(page).innerText()).includes('1 of 1'), 6000))
await snap('07-selected')

// ── 9. Manual post (no AI) from several accounts, through the editor ──
const manual = await page.evaluate((a) => window.relay.drafts.save({ body: 'Written by hand, posted from two accounts', accountId: a, status: 'ready' }), acc[0].id)
await go('#/scheduler')
await go(`#/posts?draft=${manual.id}`)
await page.locator('main button:has-text("Publish now")').click()
const pd = page.locator('[role="dialog"]').last()
await pd.locator('button:has-text("Also post from other accounts")').click()
await pd.locator('[aria-label="Also post from Brand relay_b"]').click()
await page.waitForTimeout(400)
check('manual multi-account: blocked until the same text is allowed explicitly', await pd.locator('button:has-text("Publish now")').last().isDisabled())
await pd.locator('[role="switch"][aria-label="Post the same text from several accounts"]').click()
await snap('09-manual-multi')
const postsBefore9 = (await fxPosts()).length
await pd.locator('button:has-text("Publish now")').last().click()
check('… “Sent to the queue for 2 accounts”', await toastShown('Sent to the queue for 2 accounts'))
check('… published once from each account, text unchanged', await waitFor(async () => (await fxPosts()).length - postsBefore9 === 2, 120000) && (await fxPosts()).slice(postsBefore9).every((p) => p.text === 'Written by hand, posted from two accounts') && new Set((await fxPosts()).slice(postsBefore9).map((p) => p.handle)).size === 2, JSON.stringify((await fxPosts()).slice(postsBefore9)))

// ── 10. Automation that posts your own drafts (no AI text) ──
const mine = []
for (const body of ['My own draft for the automation, number one', 'My own draft for the automation, number two']) mine.push(await page.evaluate((b) => window.relay.drafts.save({ body: b, accountId: null, status: 'draft' }), body))
await page.evaluate(() => localStorage.removeItem('axora.automation.draft'))
await go('#/scheduler')
await go('#/automation')
await page.waitForSelector('#auto-prompt')
await page.locator('[role="radio"]:has-text("My drafts")').first().click()
for (const d of mine) await page.locator(`[aria-label="Use draft: ${d.body.slice(0, 100)}"]`).click()
check('drafts source: plan uses 2 of your drafts, nothing generated', await waitFor(async () => (await summary(page).innerText()).includes('2 from your drafts'), 8000), (await summary(page).innerText()).replace(/\n/g, ' | '))
await snap('10-drafts-source')
const aiTextBefore = ai.state.log.filter((l) => l.path === '/v1/responses' || l.path === '/v1/chat/completions').length
const postsBefore10 = (await fxPosts()).length
await page.locator('aside[aria-label="Summary"] button:has-text("Start automation")').click()
await page.locator('[role="dialog"]').last().locator('button:has-text("Start")').last().click()
const run10 = await waitFor(async () => (await page.evaluate(() => window.relay.runs.list()))[0]?.config.content.source === 'drafts', 10000) ? (await page.evaluate(() => window.relay.runs.list()))[0] : null
check('drafts run: your drafts published unchanged', run10 !== null && (await waitFor(async () => (await details(run10.id)).run.status === 'completed', 150000)) && (await fxPosts()).slice(postsBefore10).map((p) => p.text).sort().join('|') === mine.map((d) => d.body).sort().join('|'), JSON.stringify((await fxPosts()).slice(postsBefore10).map((p) => p.text)))
check('… no AI text request made', ai.state.log.filter((l) => l.path === '/v1/responses' || l.path === '/v1/chat/completions').length === aiTextBefore)
check('… run items marked as your drafts', run10 !== null && (await details(run10.id)).items.every((i) => i.fromDraft && mine.some((d) => d.id === i.draftId)))

// ── 11. Automation Schedule (recurring, separate from post schedules) ──
await go('#/automation-schedule')
await page.waitForSelector('h1:has-text("Automation Schedule")')
check('Automation Schedule page in the navigation', (await page.locator('nav a:has-text("Automation Schedule")').count()) === 1)
await page.locator('main button:has-text("New schedule")').click()
const sd = page.locator('[role="dialog"]').last()
await sd.locator('#sched-name').fill('Daily tips')
await sd.locator('#sched-source').click()
await page.locator('[role="option"]:has-text("Preset: Keyboard tips preset")').click()
const pad2 = (n) => String(n).padStart(2, '0')
const nowD = new Date()
const todayStr = `${nowD.getFullYear()}-${pad2(nowD.getMonth() + 1)}-${pad2(nowD.getDate())}`
const from = new Date(nowD.getTime() - 5 * 60_000)
const untilMin = Math.min(nowD.getHours() * 60 + nowD.getMinutes() + 120, 23 * 60 + 59)
await sd.locator('#sched-start').fill(todayStr)
await sd.locator('#sched-end').fill(todayStr)
await sd.locator('#sched-from').fill(from.getDate() === nowD.getDate() ? `${pad2(from.getHours())}:${pad2(from.getMinutes())}` : '00:00')
await sd.locator('#sched-until').fill(`${pad2(Math.floor(untilMin / 60))}:${pad2(untilMin % 60)}`)
const dayBtn = sd.locator(`[role="group"][aria-label="Days of the week"] button:has-text("${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][nowD.getDay()]}")`)
if ((await dayBtn.getAttribute('aria-pressed')) !== 'true') await dayBtn.click()
await snap('11-schedule-form')
const postsBefore11 = (await fxPosts()).length
await sd.locator('button:has-text("Create schedule")').click()
check('schedule created', await toastShown('Schedule created'))
const sch = async () => (await page.evaluate(() => window.relay.automationSchedules.list())).find((x) => x.name === 'Daily tips')
check('… today is inside its days and hours → today’s run starts by itself', await waitFor(async () => Boolean((await sch())?.lastRunId), 30000), JSON.stringify(await sch()))
const sRun = (await sch()).lastRunId
check('… the run comes from the schedule, named for the day', (await details(sRun)).run.scheduleId === (await sch()).id && (await details(sRun)).run.name === `Daily tips · ${todayStr}`)
check('… and publishes (3 posts with images, from the preset)', await waitFor(async () => (await details(sRun)).run.status === 'completed', 180000) && (await fxPosts()).length - postsBefore11 === 3 && (await fxPosts()).slice(postsBefore11).every((p) => p.files === 1))
const schId = (await sch()).id
check('… only once per day', (await page.evaluate(() => window.relay.runs.list())).filter((r) => r.scheduleId === schId).length === 1)
await go('#/scheduler')
await go('#/automation-schedule')
const row = page.locator('ul[aria-label="Automation schedules"] > li', { hasText: 'Daily tips' })
check('schedule row: days, hours, dates and the last run', (await row.innerText()).includes(todayStr) && (await row.innerText()).includes('last run'))
await row.locator('button:has-text("Pause")').click()
check('pause → Paused', await toastShown('Schedule paused') && (await sch()).status === 'paused')
await row.locator('button:has-text("Resume")').click()
check('resume → Active (no second run today)', await toastShown('Schedule resumed') && (await sch()).status === 'active' && (await page.evaluate(() => window.relay.runs.list())).filter((r) => r.name.startsWith('Daily tips')).length === 1)
await snap('12-schedules')

// Notifications contain no codes or technical details
await page.locator('button[aria-label^="Notifications"]').click()
await page.waitForTimeout(400)
const centre = await page.locator('h2:text-is("Notifications")').locator('xpath=../..').innerText().catch(() => '')
check('notification centre lists automation notices (since the restart)', centre.includes('Automation stopped') && centre.includes('Post published') && centre.includes('Publishing outcome needs review'), centre.slice(0, 200))
check('… without error codes, stack traces or raw errors', centre.length > 0 && !/\b[A-Z]{2,}_[A-Z_]{2,}\b|Traceback|at .*\.js:\d+|Error:/.test(centre), centre.match(/\b[A-Z]{2,}_[A-Z_]{2,}\b|Traceback|Error:.*/)?.[0])
await snap('08-notifications')
await page.keyboard.press('Escape')

const realProblems = problems.filter((p) => !/Autofill|DevTools|Electron Security Warning/.test(p))
check('no console errors or warnings in the renderer', realProblems.length === 0, realProblems.slice(0, 3).join(' || '))

await app.close()
console.log(results.join('\n'))
const failed = results.filter((r) => r.startsWith('FAIL')).length
console.log(`\n${results.length - failed}/${results.length} passed`)
finish(failed ? 1 : 0)
