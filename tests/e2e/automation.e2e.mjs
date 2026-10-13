// Phase 12 end-to-end: AI automation runs in the real Electron app + real Python engine + real Chrome
// (three headless Chromes stand in for three IX profiles' browsers, reached over CDP) + the local X
// stand-in (engine/tests/x_fixture.py). IX Browser and OpenAI are contract MOCKS. x.com is NOT contacted.
// Needs `npm run build` first (the app is launched from out/), Google Chrome (CHROME_PATH, or the usual
// install location), and the bundled engine runtime (engine-runtime/<platform>).
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

// Profile 4's account has no confirmed username: it still posts (from its own browser), without the account check.
const HANDLES = ['relay_a', 'relay_b', 'relay_c', 'relay_d']
const CHROME = process.env.CHROME_PATH ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome')
const chromes = []
for (const handle of HANDLES) {
  const port = 9300 + Math.floor(Math.random() * 600)
  const dir = mkdtempSync(join(tmpdir(), 'axora-p12-'))
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' })
  // Windows may still hold the killed browser's files; a leftover temp folder is not a test failure.
  cleanups.push(() => { proc.kill('SIGKILL'); setTimeout(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) } catch {} }, 500) })
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

// ── IX Browser (mock): 5 profiles; 1–4 open the four browsers ──
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
  // --user-data-dir keeps the test away from a real installation's data on every OS (XDG_CONFIG_HOME only covers Linux).
  const a = await electron.launch({ executablePath: electronPath, args: [`--user-data-dir=${join(home, 'user-data')}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', project], env, cwd: project })
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
const summary = page_ => page_.locator('aside[aria-label="Start"]')
const runPanel = () => page.locator('section[aria-label="Campaign status"]')

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
check('schema v15 applied (repost_tasks included)', info.schemaVersion === 15 && info.migrations.at(-1).name === 'repost_tasks')
await page.evaluate((e) => window.relay.providers.create({ kind: 'ixbrowser', name: 'IX (mock)', endpoint: e, model: null, enabled: true }), `http://127.0.0.1:${ix.port}`)
const sync1 = await page.evaluate(() => window.relay.ixbrowser.sync())
let profiles = await page.evaluate(() => window.relay.ixbrowser.profiles())
const prof = (n) => profiles.find((p) => p.externalId === n)
let accounts = await page.evaluate(() => window.relay.accounts.list())
check('sync: every profile is linked to an account automatically', sync1.linked === 5 && accounts.length === 5 && profiles.every((p) => accounts.some((a) => a.profile?.id === p.id)), JSON.stringify({ linked: sync1.linked, accounts: accounts.length }))
const accOf = (n) => accounts.find((a) => a.profile?.externalId === n)
// Usernames are confirmed by you (nothing is read from X); profile 4 stays unconfirmed.
const acc = []
for (let i = 0; i < 3; i++) acc.push(await page.evaluate(([id, h]) => window.relay.accounts.update(id, { label: `Brand ${h}`, handle: h, confirmIdentity: true, notes: '', enabled: true }), [accOf(i + 1).id, HANDLES[i]]))
await page.evaluate((id) => window.relay.accounts.update(id, { label: 'Unconfirmed', handle: null, confirmIdentity: false, notes: '', enabled: true }), accOf(4).id)
// Profile 5 disappears from IX Browser → unavailable after the next sync.
ix.state.profiles = ix.state.profiles.slice(0, 4)
const sync2 = await page.evaluate(() => window.relay.ixbrowser.sync())
profiles = await page.evaluate(() => window.relay.ixbrowser.profiles())
accounts = await page.evaluate(() => window.relay.accounts.list())
check('sync again: no duplicate accounts; the missing profile keeps its account', sync2.linked === 0 && accounts.length === 5 && accOf(5)?.profile?.availability === 'unavailable')
const textProv = await page.evaluate((e) => window.relay.providers.create({ kind: 'openai-compatible', adapter: 'openai', name: 'Mock OpenAI', endpoint: e, model: 'gpt-test-mini', enabled: true }), `http://127.0.0.1:${ai.port}/v1`)
await page.evaluate(({ id, k }) => window.relay.providers.setKey(id, k), { id: textProv.id, k: VALID_KEY })
const imgProv = await page.evaluate((e) => window.relay.providers.create({ kind: 'image', adapter: 'openai-images', name: 'Mock Images', endpoint: e, model: 'gpt-image-test', enabled: true }), `http://127.0.0.1:${ai.port}/v1`)
await page.evaluate(({ id, k }) => window.relay.providers.setKey(id, k), { id: imgProv.id, k: VALID_KEY })
await page.evaluate(([t, i]) => window.relay.preferences.update({ defaults: { textProviderId: t, imageProviderId: i } }), [textProv.id, imgProv.id])
await page.evaluate(() => window.relay.publishing.updateSettings({ spacingMinutes: 0 }))
check('setup: 5 profiles (1 unavailable), 3 confirmed accounts, 1 unconfirmed', profiles.length === 5 && profiles.filter((p) => p.availability === 'available').length === 4 && acc.every((a) => a.identity === 'confirmed'), profiles.map((p) => p.availability).join())

// ── 0. Navigation: Create Post, Campaigns, Synchronized Profiles ──
const navAutomation = await page.locator('nav').getByRole('link').allInnerTexts()
check('navigation: Create Post, Campaigns and Synchronized Profiles', ['Create Post', 'Campaigns', 'Synchronized Profiles'].every((l) => navAutomation.some((t) => t.includes(l))) && !navAutomation.some((t) => /AI Tweet Generator|Posts & Drafts|Automation Schedule|Scheduler|Task Queue|Campaign Automation|Accounts & Profiles|^Automation$/.test(t.trim())), navAutomation.join(' | '))
check('navigation: Dashboard, Post Links and Settings unchanged', ['Dashboard', 'Post Links', 'Settings'].every((l) => navAutomation.some((t) => t.includes(l))))
await go('#/accounts')
check('Synchronized Profiles: opens on the profiles, each shown as Connected or Unavailable', await waitFor(async () => (await page.locator('table[aria-label="Browser profiles"] tbody tr', { hasText: 'Connected' }).count()) === 4 && (await page.locator('table[aria-label="Browser profiles"] tbody tr', { hasText: 'Unavailable' }).count()) >= 1, 8000), (await page.locator('main').innerText().catch(() => '')).slice(0, 200))
await snap('00-synchronized-profiles')

// ── 1. Create Post: AI post (+ generated image) and Manual post → one campaign on All accounts ──
await page.evaluate(() => { localStorage.removeItem('axora.automation.draft'); localStorage.removeItem('relay.generator.brief') })
await go('#/create?mode=ai')
await page.waitForSelector('#gen-topic')
check('Create Post: AI / Manual toggle, AI selected', (await page.locator('[role="radio"][aria-checked="true"]:has-text("AI Post")').count()) === 1 && (await page.locator('[role="radio"]:has-text("Manual Post")').count()) === 1)
await page.locator('#gen-topic').fill('keyboard shortcuts')
await page.locator('#gen-points').fill('Short practical tips for developers. Original, no invented statistics.')
await page.locator('form[aria-label="Generation brief"] button[type="submit"]').click()
check('AI: variations generated', await waitFor(async () => (await page.locator('article', { hasText: 'Idea #' }).count()) >= 1, 30000))
await snap('01-create-ai')
await page.locator('article', { hasText: 'Idea #' }).first().getByRole('button', { name: 'Use this post' }).click()
await page.waitForSelector('main textarea[aria-label="Post text"]')
const aiText = await page.locator('main textarea[aria-label="Post text"]').inputValue()
const aiDraftId = new URLSearchParams((await page.evaluate(() => location.hash)).split('?')[1]).get('draft')
check('AI: chosen post opens in the editor for preview/edit', aiText.startsWith('Idea #') && Boolean(aiDraftId), aiText)
// Image from the image provider, attached in the editor
await page.getByRole('button', { name: 'Generate', exact: true }).first().click()
await page.locator('#image-prompt').fill('A tidy keyboard on a wooden desk, morning light')
await page.locator('section[aria-label="Image generation"]').getByRole('button', { name: 'Generate', exact: true }).click()
await page.locator('section[aria-label="Image generation"]').getByRole('button', { name: 'Attach' }).first().click({ timeout: 30000 })
await page.waitForTimeout(400)
await page.keyboard.press('Control+s'); await page.waitForTimeout(800)
const aiDraft = (await page.evaluate(() => window.relay.drafts.list())).find((d) => d.id === aiDraftId)
check('AI: generated image attached and saved with the post', aiDraft?.media.length === 1 && aiDraft.origin === 'ai', JSON.stringify(aiDraft?.media))
await snap('02-create-ai-editor')

// Manual post
await page.locator('[role="radio"]:has-text("Manual Post")').click()
await page.waitForTimeout(400)
const manualText = 'Manual post: Ctrl+K opens the command palette.'
await page.locator('main textarea[aria-label="Post text"]').fill(manualText)
await page.keyboard.press('Control+s')
check('Manual: post saved', await waitFor(async () => (await page.evaluate(() => window.relay.drafts.list())).some((d) => d.body === manualText), 8000))
const manualDraft = (await page.evaluate(() => window.relay.drafts.list())).find((d) => d.body === manualText)
check('Manual: saved posts list shows both posts', await waitFor(async () => (await page.locator('ul[aria-label="Drafts"]').innerText()).includes(manualText) && (await page.locator('ul[aria-label="Drafts"]').innerText()).includes(aiText.slice(0, 20)), 8000), (await page.locator('ul[aria-label="Drafts"]').innerText().catch(() => '')).slice(0, 200))
await page.locator('main button:has-text("Use in a campaign")').click()
await page.waitForSelector('#camp-name')
check('“Use in a campaign” opens Campaigns with the post selected', (await page.locator(`[aria-label="Use draft: ${manualText.slice(0, 100)}"]`).getAttribute('aria-checked')) === 'true' || (await page.locator(`[aria-label="Use draft: ${manualText.slice(0, 100)}"]`).isChecked()))
await page.locator(`[aria-label="Use draft: ${aiText.slice(0, 100)}"]`).click()
await page.locator('#camp-name').fill('Keyboard tips')
check('campaign form: Action, Profiles, Posts, Run time only', (await page.locator('main section[aria-label]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))).filter((l) => ['Action', 'Profiles', 'Posts', 'Run time'].includes(l)).length === 4 && (await page.locator('#camp-interval, #camp-per-profile, [aria-label="Posting days"]').count()) === 0)
check('action type: Post selected, Repost available', (await page.locator('[role="radio"][aria-checked="true"]:has-text("Post")').count()) === 1 && (await page.locator('[role="radio"]:has-text("Repost")').count()) === 1)
const profilesSection = page.locator('section[aria-label="Profiles"]')
check('campaign: no profile selection — every eligible synchronized profile counted', await waitFor(async () => (await profilesSection.innerText()).includes('4 of 5 synchronized profiles take part'), 8000) && (await profilesSection.locator('[role="radio"], [role="checkbox"], input[type="checkbox"]').count()) === 0, (await profilesSection.innerText().catch(() => '')).replace(/\n/g, ' | '))
check('start panel: every post on every profile — 8 posts on 4 profiles (2 posts × 4 profiles)', await waitFor(async () => (await summary(page).innerText()).includes('8 posts on 4 profiles (2 posts × 4 profiles)') && (await summary(page).innerText()).includes('can’t be used'), 8000), (await summary(page).innerText().catch(() => '')).replace(/\n/g, ' | '))
await snap('03-campaign')
// A saved setup for the dashboard quick start (presets are created by older versions / IPC)
await page.evaluate((c) => window.relay.presets.save({ name: 'Keyboard tips preset', config: c }), baseConfig({ name: 'Keyboard tips preset' }))

const postsBefore1 = (await fxPosts()).length
await page.locator('aside[aria-label="Start"] button:has-text("Start campaign")').click()
check('one click starts the campaign', await toastShown('Campaign started'))
let run1 = await page.evaluate(() => window.relay.runs.active())
check('campaign run created: the two saved posts × 4 profiles = 8 tasks', run1?.mode === 'full-auto' && run1.counts.total === 8, String(run1?.counts.total))
const published1 = await waitFor(async () => (await fxPosts()).length - postsBefore1 >= 8 && (await details(run1.id)).run.status === 'completed', 240000)
await snap('04-campaign-finished')
const posts1 = (await fxPosts()).slice(postsBefore1)
const d1 = await details(run1.id)
check('campaign: 8 posts published with no per-post confirmation', published1 && posts1.length === 8, `posts=${posts1.length} status=${d1.run.status}`)
check('… each of the 2 posts went out exactly once from each of the 4 accounts, each from its own profile browser', HANDLES.every((h) => [aiText, manualText].every((t) => posts1.filter((p) => p.handle === h && p.text === t).length === 1)), JSON.stringify(posts1.map((p) => [p.handle, p.text.slice(0, 12)])))
check('… the saved posts went out unchanged (AI one with its image, manual one text-only)', posts1.filter((p) => p.text === aiText).every((p) => p.files === 1) && posts1.filter((p) => p.text === manualText).every((p) => p.files === 0), JSON.stringify(posts1.map((p) => [p.text, p.files])))
check('run items: from your posts, published, verified post link', d1.items.length === 8 && d1.items.every((i) => i.fromDraft && i.scheduleStatus === 'completed' && /^https:\/\/x\.com\/relay_[abcd]\/status\/\d+$/.test(i.postUrl ?? '')), JSON.stringify(d1.items.map((i) => [i.status, i.scheduleStatus, i.postUrl])))
check('results per post: each published on 4 of 4 accounts', (await runPanel().locator('ul[aria-label="Results per post"] li', { hasText: 'Published on 4 of 4 accounts' }).count()) === 2)
check('… each link matches the post the stand-in received', d1.items.every((i) => posts1.some((p) => i.postUrl === `https://x.com/${p.handle}/status/${p.id}`)))
const links1 = await page.evaluate(() => window.relay.links.list())
check('post links recorded', d1.items.every((i) => links1.some((l) => l.url === i.postUrl)))
check('IX: every eligible profile was opened, the unavailable one never', [1, 2, 3, 4].every((n) => ix.state.log.some((l) => l.url === '/api/v2/profile-open' && l.params.profile_id === n)) && !ix.state.log.some((l) => l.url === '/api/v2/profile-open' && l.params.profile_id === 5))
const ixCalls = (n) => ix.state.log.map((l, i) => ({ i, url: l.url, id: l.params?.profile_id })).filter((l) => l.id === n)
check('IX lifecycle: each profile opened only when its post was due and closed after it (open → close, nothing left open)', [1, 2, 3, 4].every((n) => { const c = ixCalls(n); const lastOpen = c.filter((x) => x.url === '/api/v2/profile-open').at(-1)?.i ?? -1; const lastClose = c.filter((x) => x.url === '/api/v2/profile-close').at(-1)?.i ?? -1; return lastOpen >= 0 && lastClose > lastOpen }) && [1, 2, 3, 4].every((n) => !ix.state.openedApi.has(n)), JSON.stringify([...ix.state.openedApi]))
check('image request went to the image endpoint with the chosen model', ai.state.log.filter((l) => l.path === '/v1/images/generations' && l.body?.model === 'gpt-image-test').length === 1)
check('“Post published” and “Automation finished” notices', (await toastShown('Post published')) && (await toastShown('Automation finished')))
check('campaign status: Completed, with a result for each profile (View on X)', (await runPanel().getByText('Completed').isVisible()) && (await runPanel().locator('ul[aria-label="Results per profile"] li').count()) === 8 && (await runPanel().locator('button[aria-label="View on X"]').count()) === 8)

// ── 2. Manual Approval: approve, edit, regenerate, remove (Selected Profiles) ──
const postsBefore2 = (await fxPosts()).length
const run2 = await page.evaluate((c) => window.relay.runs.start(c), baseConfig({ name: 'Approval run', mode: 'manual-approval', targets: { scope: 'selected', profileIds: [prof(1).id, prof(2).id] }, schedule: { postsPerProfile: 2 } }))
check('Manual Approval: 4 posts generated and waiting', await waitFor(async () => (await details(run2.id)).run.counts.awaitingApproval === 4, 60000), JSON.stringify((await details(run2.id)).run.counts))
await sleep(2500)
check('… nothing published before approval', (await fxPosts()).length === postsBefore2)
check('… only the selected profiles are used', (await details(run2.id)).items.every((i) => [prof(1).id, prof(2).id].includes(i.profileId)))
check('“ready for your approval” notice', await toastShown('ready for your approval'))
await go(`#/campaigns?run=${run2.id}`)
await runPanel().waitFor()
await snap('04-approval')
let items2 = (await details(run2.id)).items
const [iRegen, iRemove, iEdit, iApprove] = items2
const rows = () => runPanel().locator('ul[aria-label="Results per profile"] > li')
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
await go(`#/campaigns?run=${run2.id}`)
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
await go(`#/campaigns?run=${run3.id}`)
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
await go(`#/campaigns?run=${run4.id}`)
await runPanel().waitFor()
await page.evaluate((id) => window.relay.runs.setMode(id, 'full-auto'), run4.id)
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
check('not found on the profile → needs review (not retried)', await waitFor(async () => (await details(run5b.id)).items[0]?.scheduleStatus === 'needs-review', 150000), JSON.stringify(await page.evaluate((d) => window.relay.queue.list({ view: 'all' }).then((ts) => ts.filter((t) => t.draftId === d).map((t) => ({ status: t.status, attempts: t.attempts, error: t.error, stage: t.stage, runAfter: t.runAfter, held: t.held }))), (await details(run5b.id)).items[0]?.draftId)))
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
check('dashboard preset quick start → Campaigns with the saved setup', await waitFor(async () => (await page.locator('#camp-name').inputValue()) === 'Keyboard tips preset' && (await page.evaluate(() => location.hash)).startsWith('#/campaigns'), 8000), await page.evaluate(() => location.hash))

check('campaign page: no profile or account selection anywhere', (await page.locator('main [aria-label^="Select "], main [role="radio"]:has-text("Select profiles"), main [role="radio"]:has-text("All profiles")').count()) === 0)

// ── 9. Create Post: comment section, then Publish from every profile (no account selection) ──
await go('#/dashboard')
await go('#/create')
await page.waitForSelector('main textarea[aria-label="Post text"]')
check('Create Post: no account selector in the editor', (await page.locator('main [aria-label="Account"]').count()) === 0)
const manualBody = 'Written by hand, posted from every profile'
const commentBody = 'Comment: the notes are at https://example.com/notes'
await page.locator('main textarea[aria-label="Post text"]').fill(manualBody)
check('Create Post: comment section below the post, off by default', (await page.locator('main section[aria-label="Comment"]').count()) === 1 && (await page.locator('main textarea[aria-label="Comment text"]').count()) === 0)
await page.locator('main [role="switch"][aria-label="Post a comment under this post"]').click()
await page.locator('main textarea[aria-label="Comment text"]').fill(commentBody)
check('Create Post: the preview shows the comment as a reply, apart from the post', await waitFor(async () => /comment \(reply\)/i.test(await page.locator('main').innerText()), 4000))
await page.keyboard.press('Control+s')
check('post saved with its comment and no account', await waitFor(async () => (await page.evaluate(() => window.relay.drafts.list())).some((d) => d.body === manualBody && d.comment.enabled && d.comment.text === commentBody && d.accountId === null), 8000))
const manual = (await page.evaluate(() => window.relay.drafts.list())).find((d) => d.body === manualBody)
await snap('09-create-comment')
await page.locator('main button:has-text("Publish…")').click()
const pd = page.locator('[role="dialog"]').last()
await pd.waitFor()
check('publish: every eligible synchronized profile, nothing to select', await waitFor(async () => (await pd.innerText()).includes('4 of 5 synchronized profiles will post'), 8000) && (await pd.locator('[role="checkbox"], [aria-label^="Publish from "]').count()) === 0, (await pd.innerText()).replace(/\n/g, ' | ').slice(0, 300))
check('publish: the unconfirmed username is a warning, not a block', (await pd.innerText()).includes('no confirmed X username'))
check('publish: same text on several accounts must be allowed explicitly', await pd.locator('button:has-text("Publish on 4 profiles")').isDisabled())
await pd.locator('[role="switch"][aria-label="Post the same text from several accounts"]').click()
await snap('10-publish-dialog')
const postsBefore9 = (await fxPosts()).length
await pd.locator('button:has-text("Publish on 4 profiles")').click()
check('… “Sent to the queue for 4 profiles”', await toastShown('Sent to the queue for 4 profiles'))
check('… live progress: each profile published, then its comment posted', await waitFor(async () => (await pd.locator('ul[aria-label="Publishing progress"] li', { hasText: 'Published' }).count()) === 4 && (await pd.locator('ul[aria-label="Publishing progress"] li', { hasText: 'Posted' }).count()) === 4, 180000), await pd.innerText().catch(() => ''))
const posts9 = (await fxPosts()).slice(postsBefore9)
const posted9 = posts9.filter((p) => !p.inReplyTo)
const replies9 = posts9.filter((p) => p.inReplyTo)
check('… one post from each of the 4 profiles, text unchanged', posted9.length === 4 && posted9.every((p) => p.text === manualBody) && new Set(posted9.map((p) => p.handle)).size === 4, JSON.stringify(posts9.map((p) => [p.handle, p.inReplyTo])))
check('… each comment is a reply from the same account to its own post', replies9.length === 4 && replies9.every((r) => r.text.trim() === commentBody && posted9.some((p) => p.id === r.inReplyTo && p.handle === r.handle)), JSON.stringify(replies9.map((r) => [r.handle, r.inReplyTo])))
await snap('11-publish-progress')
await pd.locator('button:has-text("Close")').last().click()

// Schedule from Create Post: a date and time, every profile, nothing published early.
const later = await page.evaluate(() => window.relay.drafts.save({ body: 'Scheduled from Create Post', accountId: null, status: 'ready' }))
await go('#/dashboard')
await go(`#/create?draft=${later.id}`)
await page.locator('main button:has-text("Publish…")').click()
const sd = page.locator('[role="dialog"]').last()
await sd.waitFor()
await sd.locator('[role="radio"]:has-text("Schedule")').click()
await sd.getByRole('button', { name: 'Tomorrow, 09:00' }).click()
await sd.locator('[role="switch"][aria-label="Post the same text from several accounts"]').click()
const postsBeforeSched = (await fxPosts()).length
await sd.locator('button:has-text("Schedule on 4 profiles")').click()
check('schedule: “Scheduled on 4 profiles”', await toastShown('Scheduled on 4 profiles'))
const laterSchedules = (await page.evaluate(() => window.relay.publishing.list({ view: 'upcoming' }))).filter((e) => e.draft?.preview?.startsWith('Scheduled from Create Post'))
check('… four schedules for tomorrow 09:00 (this computer’s time), nothing published yet', laterSchedules.length === 4 && laterSchedules.every((e) => { const t = new Date(e.schedule.runAt); return t.getHours() === 9 && t.getMinutes() === 0 && t.getTime() > Date.now() }) && (await fxPosts()).length === postsBeforeSched, JSON.stringify(laterSchedules.map((e) => e.schedule.runAt)))
await sd.locator('button:has-text("Close")').last().click()
for (const e of laterSchedules) await page.evaluate((id) => window.relay.publishing.unschedule(id), e.schedule.id)
check('… cancelled schedules return the post to the editor with nothing unsaved', await waitFor(async () => (await page.evaluate((id) => window.relay.drafts.list().then((ds) => ds.find((d) => d.id === id)?.status), later.id)) === 'ready', 8000) && (await waitFor(async () => (await page.locator('main section[aria-label="Edit draft"] header').innerText()).includes('Saved'), 5000)) && (await page.locator('main').getByText('Unsaved changes').count()) === 0)

// ── 10. Post campaign with a run time; then stop ──
const sched = []
for (const body of ['Scheduled campaign post one', 'Scheduled campaign post two']) sched.push(await page.evaluate((b) => window.relay.drafts.save({ body: b, accountId: null, status: 'draft' }), body))
await page.evaluate(() => localStorage.removeItem('axora.campaign.choices'))
await go('#/dashboard')
await go('#/campaigns')
await page.waitForSelector('#camp-name')
await page.locator('#camp-name').fill('Tomorrow morning')
for (const d of sched) await page.locator(`[aria-label="Use draft: ${d.body.slice(0, 100)}"]`).click()
await page.locator('section[aria-label="Run time"] [role="radio"]:has-text("At a date and time")').click()
const tomorrow = new Date(Date.now() + 86_400_000)
const p2 = (n) => String(n).padStart(2, '0')
await page.locator('#camp-start').fill(`${tomorrow.getFullYear()}-${p2(tomorrow.getMonth() + 1)}-${p2(tomorrow.getDate())}T10:00`)
check('run time: start panel shows 8 posts on 4 profiles from tomorrow 10:00', await waitFor(async () => (await summary(page).innerText()).includes('8 posts on 4 profiles') && (await summary(page).innerText()).includes('10:00'), 8000), (await summary(page).innerText()).replace(/\n/g, ' | '))
await snap('11-scheduled-campaign')
await page.locator('aside[aria-label="Start"] button:has-text("Start campaign")').click()
const run10 = await waitFor(async () => (await page.evaluate(() => window.relay.runs.list()))[0]?.name === 'Tomorrow morning', 10000) ? (await page.evaluate(() => window.relay.runs.list()))[0] : null
check('… all 8 (2 posts × 4 profiles) wait for the run time (nothing published yet)', run10 !== null && (await waitFor(async () => (await details(run10.id)).items.length === 8 && (await details(run10.id)).items.every((i) => i.scheduleStatus === 'pending'), 20000)), run10 && JSON.stringify((await details(run10.id)).items.map((i) => [i.scheduleStatus, i.runAt])))
if (run10) {
  const times = (await details(run10.id)).items.map((i) => new Date(i.runAt))
  check('… at tomorrow 10:00, every post on every synchronized profile', times.every((t) => t.getDate() === tomorrow.getDate() && t.getHours() === 10 && t.getMinutes() === 0) && new Set((await details(run10.id)).items.map((i) => i.profileId)).size === 4 && new Set((await details(run10.id)).items.map((i) => `${i.sourceDraftId}|${i.profileId}`)).size === 8)
  check('… status shows Running with the profile results', (await runPanel().getByText('Running').first().isVisible()) && (await runPanel().locator('ul[aria-label="Results per profile"] li').count()) === 8)
  await runPanel().locator('button:has-text("Stop")').click()
  await page.locator('[role="dialog"] button:has-text("Stop")').last().click()
  check('stop: campaign stopped, posts back in your library', await waitFor(async () => (await details(run10.id)).run.status === 'stopped', 10000) && (await page.evaluate(() => window.relay.drafts.list())).filter((d) => sched.some((x) => x.id === d.id) && (d.status === 'ready' || d.status === 'draft')).length === 2)
}

// ── 11. Repost campaign: X Auto reposts in the profile's browser, confirmed from the post's state ──
const fxReposts = async () => (await fetch(`${fxBase}/__reposts`)).json()
await page.evaluate(() => window.relay.links.add({ text: 'https://x.com/someone_else/status/1999000000000000001', accountId: null, tags: [], notes: '' })).catch(() => null)
const postsBefore11 = (await fxPosts()).length
const repostsBefore11 = (await fxReposts()).length
await go('#/dashboard')
await go('#/campaigns')
await page.waitForSelector('#camp-name')
await page.locator('#camp-name').fill('Repost campaign')
await page.locator('section[aria-label="Action"] [role="radio"]:has-text("Repost")').click()
await page.locator('section[aria-label="Run time"] [role="radio"]:has-text("Now")').click()
check('repost: the post-link library is offered instead of saved posts', await waitFor(async () => (await page.locator('ul[aria-label="Post links"]').count()) === 1, 5000) && (await page.locator('ul[aria-label="Your drafts"]').count()) === 0)
await page.locator('[aria-label="Choose https://x.com/someone_else/status/1999000000000000001"]').click()
check('repost: start panel shows 1 repost', await waitFor(async () => (await summary(page).innerText()).includes('1 repost from your profiles'), 8000), (await summary(page).innerText()).replace(/\n/g, ' | '))
await snap('12-repost-campaign')
await page.locator('aside[aria-label="Start"] button:has-text("Start campaign")').click()
check('repost: campaign started', await toastShown('Campaign started'))
const run11 = await waitFor(async () => (await page.evaluate(() => window.relay.runs.list()))[0]?.name === 'Repost campaign', 10000) ? (await page.evaluate(() => window.relay.runs.list()))[0] : null
check('repost: Completed only after the repost was confirmed — the item says Reposted', run11 !== null && (await waitFor(async () => (await details(run11.id)).run.status === 'completed', 120000)) && (await waitFor(async () => (await runPanel().getByText('Reposted').count()) > 0, 8000)), run11 && JSON.stringify((await details(run11.id)).items.map((i) => [i.status, i.taskStatus, i.error])))
const reposts11 = (await fxReposts()).slice(repostsBefore11)
check('repost: X received exactly one repost of that post, from one of your accounts’ browsers', reposts11.length === 1 && reposts11[0].id === '1999000000000000001' && HANDLES.includes(reposts11[0].handle) && (await fxPosts()).length === postsBefore11, JSON.stringify(reposts11))
const eng11 = (await page.evaluate(() => window.relay.engagement.list({ status: 'all' }))).filter((e) => e.kind === 'repost')
check('repost: its Post Links task is marked done', eng11.length === 1 && eng11[0].status === 'done', JSON.stringify(eng11.map((e) => e.status)))

// A repost scheduled for a time: nothing before it, done at it.
await page.evaluate(() => window.relay.links.add({ text: 'https://x.com/later_author/status/1999000000000000009', accountId: null, tags: [], notes: '' })).catch(() => null)
const p2b = (n) => String(n).padStart(2, '0')
const at11 = new Date(Date.now() + 60_000)
at11.setSeconds(0, 0)
if (at11.getTime() - Date.now() < 25_000) at11.setMinutes(at11.getMinutes() + 1)
await go('#/dashboard')
await go('#/campaigns')
await page.waitForSelector('#camp-name')
await page.locator('#camp-name').fill('Scheduled repost')
await page.locator('section[aria-label="Action"] [role="radio"]:has-text("Repost")').click()
await page.locator('[aria-label="Choose https://x.com/later_author/status/1999000000000000009"]').click()
await page.locator('section[aria-label="Run time"] [role="radio"]:has-text("At a date and time")').click()
await page.locator('#camp-start').fill(`${at11.getFullYear()}-${p2b(at11.getMonth() + 1)}-${p2b(at11.getDate())}T${p2b(at11.getHours())}:${p2b(at11.getMinutes())}`)
await page.waitForTimeout(800)
await page.locator('aside[aria-label="Start"] button:has-text("Start campaign")').click()
const run11s = await waitFor(async () => (await page.evaluate(() => window.relay.runs.list()))[0]?.name === 'Scheduled repost', 10000) ? (await page.evaluate(() => window.relay.runs.list()))[0] : null
check('scheduled repost: shown as Scheduled for the chosen time', run11s !== null && (await waitFor(async () => (await details(run11s.id)).items[0]?.taskStatus === 'queued' && new Date((await details(run11s.id)).items[0].runAt).getTime() === at11.getTime(), 8000)), run11s && JSON.stringify((await details(run11s.id)).items))
await waitFor(async () => Date.now() > at11.getTime() - 3000, 120000)
check('… nothing reposted before its time', !(await fxReposts()).some((r) => r.id === '1999000000000000009') && (await details(run11s.id)).run.status === 'publishing')
const reposted11s = await waitFor(async () => (await fxReposts()).some((r) => r.id === '1999000000000000009'), 90000)
const doneAt11s = Date.now()
check('… reposted automatically once its time came', reposted11s && doneAt11s >= at11.getTime() && (await waitFor(async () => (await details(run11s.id)).run.status === 'completed', 60000)), `${doneAt11s - at11.getTime()} ms after the chosen time`)

// ── 11b. Comment campaign: your comment, posted as a reply to the chosen post, confirmed on X ──
await page.evaluate(() => window.relay.links.add({ text: 'https://x.com/another_author/status/1999000000000000002', accountId: null, tags: [], notes: '' })).catch(() => null)
await page.evaluate(() => window.relay.links.add({ text: 'https://x.com/third_author/status/1999000000000000003', accountId: null, tags: [], notes: '' })).catch(() => null)
const postsBefore11b = (await fxPosts()).length
await go('#/dashboard')
await go('#/campaigns')
await page.waitForSelector('#camp-name')
await page.locator('#camp-name').fill('Comment campaign')
await page.locator('section[aria-label="Action"] [role="radio"]:has-text("Comment")').click()
await page.locator('section[aria-label="Run time"] [role="radio"]:has-text("Now")').click()
check('comment: totals of available post links shown', await waitFor(async () => /\d+ post links? available/.test(await page.locator('section[aria-label="Posts to comment on"]').innerText()), 5000))
await page.locator('[aria-label="Choose https://x.com/another_author/status/1999000000000000002"]').click()
check('comment: Start blocked until you write the comment', await waitFor(async () => (await summary(page).innerText()).includes('Write the comment'), 8000) && (await page.locator('aside[aria-label="Start"] button:has-text("Start campaign")').isDisabled()))
await page.locator('#camp-comment').fill('Thanks for sharing the benchmark numbers — very useful.')
await page.locator('[aria-label="Choose https://x.com/third_author/status/1999000000000000003"]').click()
check('comment: the same comment on two posts is refused (repetitive automated replies)', await waitFor(async () => (await summary(page).innerText()).includes('one post'), 8000) && (await page.locator('aside[aria-label="Start"] button:has-text("Start campaign")').isDisabled()))
await page.locator('[aria-label="Choose https://x.com/third_author/status/1999000000000000003"]').click()
check('comment: start panel shows 1 comment', await waitFor(async () => (await summary(page).innerText()).includes('1 comment from your profiles'), 8000), (await summary(page).innerText()).replace(/\n/g, ' | '))
await snap('13-comment-campaign')
await page.locator('aside[aria-label="Start"] button:has-text("Start campaign")').click()
const run11b = await waitFor(async () => (await page.evaluate(() => window.relay.runs.list()))[0]?.name === 'Comment campaign', 10000) ? (await page.evaluate(() => window.relay.runs.list()))[0] : null
check('comment: Completed only after X confirmed it — the item says Comment posted', run11b !== null && (await waitFor(async () => (await details(run11b.id)).run.status === 'completed', 120000)) && (await waitFor(async () => (await runPanel().getByText('Comment posted').count()) > 0, 8000)), run11b && JSON.stringify((await details(run11b.id)).items.map((i) => [i.taskStatus, i.error])))
const replies11b = (await fxPosts()).slice(postsBefore11b)
check('comment: X received exactly one reply, to that post, with your text', replies11b.length === 1 && replies11b[0].inReplyTo === '1999000000000000002' && replies11b[0].text.trim() === 'Thanks for sharing the benchmark numbers — very useful.' && HANDLES.includes(replies11b[0].handle), JSON.stringify(replies11b))

// ── 12. Publishing safety on the campaign page; old addresses redirect ──
check('needs-review posts are listed with Review (publishing safety kept)', (await page.locator('section[aria-label="Needs your attention"] li', { hasText: 'Check whether it was posted' }).count()) >= 1)
await page.locator('section[aria-label="Needs your attention"] li', { hasText: 'Check whether it was posted' }).first().getByRole('button', { name: 'Review' }).click()
check('… Review opens the check-and-confirm dialog', await waitFor(async () => (await page.locator('[role="dialog"]').count()) >= 1, 5000))
await page.keyboard.press('Escape')
check('no recurring schedules, scheduling dashboard or posting-queue table on the page', (await page.locator('section[aria-label="Recurring campaigns"], section[aria-label="Scheduled posts"], section[aria-label="Posting queue"]').count()) === 0)
const hashAfter = async (h) => { await go(h); await page.waitForTimeout(300); return page.evaluate(() => location.hash) }
check('old address /posts?draft= → Create Post with that post', (await hashAfter(`#/posts?draft=${manual.id}`)) === `#/create?draft=${manual.id}`)
check('old address /generator → Create Post (AI)', (await hashAfter('#/generator')) === '#/create?mode=ai')
check('old address /automation?run= → Campaigns with that campaign', (await hashAfter(`#/automation?run=${run1.id}`)) === `#/campaigns?run=${run1.id}`)
check('old addresses /queue, /scheduler, /automation-schedule → Campaigns', (await hashAfter('#/queue?view=attention')).startsWith('#/campaigns?') && (await hashAfter('#/scheduler')).startsWith('#/campaigns') && (await hashAfter('#/automation-schedule')) === '#/campaigns')

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
