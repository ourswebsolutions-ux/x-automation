#!/usr/bin/env node
/**
 * Release notes for a tag: commits since the previous release tag, then a table of the
 * installers (platform, architecture, size) found in the given folder.
 *
 *   node scripts/release-notes.mjs v1.0.0 dist > release-notes.md
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const [tag, dir = 'dist'] = process.argv.slice(2)
if (!tag) {
  console.error('Usage: node scripts/release-notes.mjs <tag> [assets-folder]')
  process.exit(1)
}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

let previous = ''
try {
  previous = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', `${tag}^`)
} catch {
  previous = '' // first release
}
const range = previous ? `${previous}..${tag}` : tag
const commits = git('log', range, '--no-merges', '--pretty=format:- %s (%h)')
  .split('\n')
  .filter((line) => line && !/^- Release v\d/.test(line))

const kind = (name) => {
  if (name.endsWith('.AppImage')) return ['Linux', 'AppImage (portable)']
  if (name.endsWith('.deb')) return ['Linux', 'Debian/Ubuntu package']
  if (name.endsWith('.exe')) return ['Windows', 'NSIS installer']
  if (name.endsWith('.dmg')) return ['macOS', 'Disk image']
  if (name.endsWith('.zip')) return ['macOS', 'App archive']
  if (name === 'SHA256SUMS.txt') return ['All', 'SHA-256 checksums']
  return ['', '']
}
const arch = (name) => (/arm64|aarch64/.test(name) ? 'arm64' : /x64|amd64|x86_64/.test(name) ? 'x64' : '—')
const size = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`
const version = tag.replace(/^v/, '')

const files = readdirSync(dir).filter((f) => kind(f)[0]).sort()
const lines = [
  `## X Auto ${version}`,
  '',
  previous ? `Changes since ${previous}:` : 'Changes in this first release:',
  '',
  ...(commits.length ? commits : ['- Maintenance release']),
  '',
  '### Downloads',
  '',
  '| File | Platform | Architecture | Type | Size |',
  '| --- | --- | --- | --- | --- |',
  ...files.map((f) => {
    const [platform, type] = kind(f)
    return `| \`${f}\` | ${platform} | ${f === 'SHA256SUMS.txt' ? '—' : arch(f)} | ${type} | ${size(statSync(join(dir, f)).size)} |`
  }),
  '',
  '### Notes',
  '',
  '- The Python + Playwright automation engine is bundled; nothing else needs to be installed. IX Browser must be installed separately.',
  '- Installers are **unsigned** unless signing is configured: Windows SmartScreen and macOS Gatekeeper will warn (macOS: right-click → Open).',
  '- Publishing to x.com and a real IX Browser installation have not been verified by automated tests — those use local stand-ins.'
]
console.log(lines.join('\n'))
