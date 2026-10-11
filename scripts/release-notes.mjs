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
import { expectedAssets } from './release-assets.mjs'

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

const version = tag.replace(/^v/, '')
const size = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`
// Platform, architecture and type come from the single definition of a complete release.
const known = new Map(expectedAssets(version).all.map((a) => [a.name, a]))
known.set('SHA256SUMS.txt', { platform: 'All', arch: '—', type: 'SHA-256 checksums' })
const files = readdirSync(dir).filter((f) => known.has(f)).sort((a, b) => (known.get(a).platform + a).localeCompare(known.get(b).platform + b))

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
    const a = known.get(f)
    return `| \`${f}\` | ${a.platform} | ${a.arch} | ${a.type} | ${size(statSync(join(dir, f)).size)} |`
  }),
  '',
  '### Notes',
  '',
  '- The Python + Playwright automation engine is bundled; nothing else needs to be installed. IX Browser must be installed separately.',
  '- Installers are **unsigned** unless signing is configured: Windows SmartScreen and macOS Gatekeeper will warn (macOS: right-click → Open).',
  '- Updates: the Windows installer and the Linux AppImage update in the app; the Windows ZIP, Linux .deb and unsigned macOS builds announce new versions and open this page.',
  '- Publishing to x.com and a real IX Browser installation have not been verified by automated tests — those use local stand-ins.'
]
console.log(lines.join('\n'))
