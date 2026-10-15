import { LENGTH_PROFILES, type LengthProfileId } from '@shared/config/postLimits'
import { measurePost } from '@shared/lib/postLength'

/**
 * Bulk posts and comments pasted from ChatGPT (or any list): one paste becomes separate items.
 * Nothing here calls an AI service — the text is written elsewhere and pasted in.
 *
 * Formats, in the order they are recognised:
 *  1. Numbered — "1. …", "2) …", "**3.** …", "Post 4: …", "Comment #5 - …". An item runs until the
 *     next number, so it may span several lines (and paragraphs). Numbers must count up by one
 *     (from any start, e.g. 101 for a second batch), so a "3." inside a post that isn't the next
 *     number stays part of the post. Text before the first number is ChatGPT's introduction.
 *  2. Blank-line separated — when the paste has blank lines and no numbering, each block is one item
 *     (its line breaks are kept).
 *  3. One per line — otherwise every non-empty line is one item.
 * Hashtags, @mentions, links, emojis, punctuation and numbers inside the text are kept as written;
 * only the list number (and a bullet like "- " when the list uses them) is removed.
 */

export const BULK_MAX_ITEMS = 300
/** Longest text accepted for a draft (posts) or a comment draft (the reply limit for campaign comments). */
export const BULK_MAX_CHARS = { post: 25_000, comment: 4_000 } as const

export type BulkKind = 'post' | 'comment'
export type BulkFormat = 'numbered' | 'paragraphs' | 'lines' | 'empty'

export interface BulkItem {
  text: string
  /** 1-based line in the pasted text where the item starts. */
  line: number
}

export interface BulkParse {
  items: BulkItem[]
  format: BulkFormat
  /** Text that is not an item (ChatGPT's introduction or closing note, headings, separators). */
  ignored: { text: string; line: number; reason: string }[]
  /** Things worth checking in the preview (the parser never guesses silently). */
  notes: string[]
}

const MARKER = /^\s*(?:[*_]{1,2})?(?:(?:posts?|tweets?|x\s+posts?|comments?|replies|reply)\s*#?\s*)?(\d{1,4})(?:[*_]{1,2})?\s*(?:[.):](?=\s|$|[*_])|\s[-–—](?=\s))(?:[*_]{1,2})?[ \t]*/i
const SEPARATOR = /^\s*(?:-{3,}|\*{3,}|_{3,}|={3,})\s*$/
const HEADING = /^\s*#{1,6}\s+\S/
const BOLD_LINE = /^\s*\*\*[^*]+\*\*:?\s*$/
const BULLET = /^\s*(?:[-•*]|–)\s+/
const INTRO = /^\s*(?:sure|certainly|absolutely|of course|okay|ok|great|here(?:['’]s| is| are)|below (?:are|is)|i(?:['’]ve| have) (?:written|created|prepared|put together))\b/i
const CLOSING = /^\s*(?:let me know|feel free|i hope|hope (?:this|these|that)|would you like|do you want|want me to|if you(?:['’]d| would)? like|if you need|these (?:posts|comments|tweets|replies)|you can (?:also )?(?:customi[sz]e|adjust|tweak|edit|mix)|happy (?:posting|tweeting)|enjoy|good luck|note:|tip:|(?:i )?can (?:also )?(?:create|write|make|generate))/i

/** Splits pasted text into posts or comments. */
export function parseBulk(input: string): BulkParse {
  const lines = input.replace(/\r\n?/g, '\n').split('\n')
  if (!lines.some((l) => l.trim())) return { items: [], format: 'empty', ignored: [], notes: [] }
  return parseNumbered(lines) ?? parseUnnumbered(lines)
}

function parseNumbered(lines: string[]): BulkParse | null {
  // The numbered items: a marker counts only when it continues the count (prev + 1).
  const starts: { index: number; rest: string; bold: boolean }[] = []
  let expected: number | null = null
  for (let i = 0; i < lines.length; i++) {
    const m = MARKER.exec(lines[i]!)
    if (!m) continue
    const n = Number(m[1])
    if (expected !== null && n !== expected) continue
    // The first number starts the list only at the start of a block (not mid-paragraph).
    if (expected === null && i > 0 && !startsBlock(lines[i - 1]!)) continue
    starts.push({ index: i, rest: lines[i]!.slice(m[0].length), bold: /^\s*[*_]{2}/.test(m[0]) })
    expected = n + 1
  }
  if (starts.length < 2) return null

  const ignored: BulkParse['ignored'] = []
  const notes: string[] = []
  const intro = lines.slice(0, starts[0]!.index).join('\n').trim()
  if (intro) ignored.push({ text: intro, line: firstLine(lines, 0), reason: 'Introduction (before item 1)' })

  const items: BulkItem[] = []
  starts.forEach((start, k) => {
    const end = k + 1 < starts.length ? starts[k + 1]!.index : lines.length
    const body: string[] = [start.rest]
    for (let i = start.index + 1; i < end; i++) {
      const line = lines[i]!
      if (SEPARATOR.test(line)) {
        ignored.push({ text: line.trim(), line: i + 1, reason: 'Separator line' })
        continue
      }
      // A heading between items (e.g. "### Motivation", or a bold line on its own) is not part of a post.
      if (HEADING.test(line) || (BOLD_LINE.test(line) && (i + 1 >= end || !lines[i + 1]!.trim()))) {
        ignored.push({ text: line.trim(), line: i + 1, reason: 'Heading' })
        continue
      }
      body.push(line)
    }
    let paragraphs = splitParagraphs(body)
    // The last item: a following paragraph that reads like ChatGPT's closing note is not part of it.
    if (k === starts.length - 1) {
      while (paragraphs.length > 1 && CLOSING.test(paragraphs.at(-1)!)) {
        ignored.unshift({ text: paragraphs.at(-1)!, line: lineOf(lines, paragraphs.at(-1)!, start.index), reason: 'Closing note (after the last item)' })
        paragraphs = paragraphs.slice(0, -1)
      }
      if (paragraphs.length > 1 && !items.some((it) => it.text.includes('\n\n'))) {
        notes.push(`Item ${k + 1} has more than one paragraph — check that the last one belongs to it (and isn’t a note from ChatGPT).`)
      }
    }
    let text = clean(paragraphs.join('\n\n'))
    if (start.bold) text = text.replace(/^\*\*(.+?)\*\*$/s, '$1').replace(/\*\*$/, '')
    if (!text) notes.push(`Item ${k + 1} (line ${start.index + 1}) is empty.`)
    items.push({ text, line: start.index + 1 })
  })
  return { items, format: 'numbered', ignored: ignored.sort((a, b) => a.line - b.line), notes }
}

function parseUnnumbered(lines: string[]): BulkParse {
  const ignored: BulkParse['ignored'] = []
  const notes: string[] = []
  const blocks: BulkItem[] = []
  const hasBlank = lines.some((l, i) => !l.trim() && lines.slice(0, i).some((x) => x.trim()) && lines.slice(i + 1).some((x) => x.trim()))
  const multiLineBlock = hasBlank && hasMultiLineBlock(lines)
  const format: BulkFormat = multiLineBlock ? 'paragraphs' : 'lines'

  let current: string[] = []
  let currentLine = 0
  const flush = () => {
    if (current.length) blocks.push({ text: current.join('\n'), line: currentLine })
    current = []
  }
  lines.forEach((line, i) => {
    if (SEPARATOR.test(line)) {
      flush()
      ignored.push({ text: line.trim(), line: i + 1, reason: 'Separator line' })
      return
    }
    if (HEADING.test(line)) {
      flush()
      ignored.push({ text: line.trim(), line: i + 1, reason: 'Heading' })
      return
    }
    if (!line.trim()) return flush()
    if (format === 'lines') {
      blocks.push({ text: line, line: i + 1 })
      return
    }
    if (!current.length) currentLine = i + 1
    current.push(line)
  })
  flush()

  // ChatGPT's introduction ("Here are 300 posts…:") and closing note ("Let me know…").
  while (blocks.length && (INTRO.test(blocks[0]!.text) && /[:!.]\s*$/.test(blocks[0]!.text.split('\n')[0]!) && !/#\w/.test(blocks[0]!.text))) {
    const b = blocks.shift()!
    ignored.push({ text: b.text.trim(), line: b.line, reason: 'Introduction' })
  }
  while (blocks.length > 1 && CLOSING.test(blocks.at(-1)!.text)) {
    const b = blocks.pop()!
    ignored.push({ text: b.text.trim(), line: b.line, reason: 'Closing note' })
  }
  // Bullets ("- …", "• …") are list markers when most items use them.
  const bulleted = blocks.filter((b) => BULLET.test(b.text)).length
  const stripBullets = blocks.length > 1 && bulleted * 2 >= blocks.length
  const items = blocks.map((b) => ({ text: clean(stripBullets ? b.text.replace(BULLET, '') : b.text), line: b.line }))
  if (format === 'paragraphs') notes.push('Items are separated by blank lines; each block is one item. If every line should be its own item, remove the blank lines.')
  else if (items.length > 1 && !hasBlank) notes.push('One item per line. For posts that span several lines, number them (1., 2., …) or put a blank line between them.')
  return { items, format, ignored, notes }
}

/** The line before a list's first number: blank, a heading, a separator, or an introduction ending in ":". */
function startsBlock(previous: string): boolean {
  return !previous.trim() || SEPARATOR.test(previous) || HEADING.test(previous) || BOLD_LINE.test(previous) || INTRO.test(previous) || /:\s*$/.test(previous)
}

function hasMultiLineBlock(lines: string[]): boolean {
  let run = 0
  for (const l of lines) {
    if (l.trim() && !SEPARATOR.test(l) && !HEADING.test(l)) {
      run++
      if (run > 1) return true
    } else run = 0
  }
  return false
}

/** Paragraphs of an item (lines grouped by blank lines), trimmed, empty ones dropped. */
function splitParagraphs(body: string[]): string[] {
  return body
    .join('\n')
    .split(/\n[ \t]*\n/)
    .map((p) => p.replace(/^\s*\n|\s+$/g, '').replace(/^[ \t]+/, ''))
    .filter((p) => p.trim())
}

/** Trims the item and removes quotes ChatGPT sometimes wraps a whole post in. */
function clean(text: string): string {
  let t = text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
  const quoted = /^["“](.+)["”]$/s.exec(t)
  if (quoted && !/["“”]/.test(quoted[1]!)) t = quoted[1]!.trim()
  return t
}

function firstLine(lines: string[], from: number): number {
  for (let i = from; i < lines.length; i++) if (lines[i]!.trim()) return i + 1
  return from + 1
}

function lineOf(lines: string[], paragraph: string, from: number): number {
  const first = paragraph.split('\n')[0]!.trim()
  for (let i = from; i < lines.length; i++) if (lines[i]!.trim() === first) return i + 1
  return from + 1
}

// ── validation ─────────────────────────────────────────────────────────────

export interface BulkProblem {
  message: string
  /** Blocking problems keep the item from being saved (it stays in the list to fix). */
  blocking: boolean
}

/** The comparison key for duplicates: same words, ignoring spacing and letter case. */
export const duplicateKey = (text: string) => text.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase()

/** What is wrong with one item: empty, longer than allowed, or longer than X's limit for the chosen length. */
export function bulkItemProblems(text: string, kind: BulkKind, lengthProfile: LengthProfileId): BulkProblem[] {
  const trimmed = text.trim()
  const noun = kind === 'post' ? 'post' : 'comment'
  if (!trimmed) return [{ message: `Empty — write the ${noun} or remove it.`, blocking: true }]
  if (trimmed.length > BULK_MAX_CHARS[kind]) return [{ message: `Longer than ${BULK_MAX_CHARS[kind].toLocaleString()} characters — shorten it (nothing is cut automatically).`, blocking: true }]
  const limit = LENGTH_PROFILES[lengthProfile].maxWeighted
  const length = measurePost(trimmed, limit)
  if (length.isOver) {
    return [
      {
        message:
          lengthProfile === 'standard'
            ? `${length.weighted.toLocaleString()} characters — over X’s 280 limit. Shorten it, or choose “Longer posts” if your accounts have X Premium.`
            : `${length.weighted.toLocaleString()} characters — over X’s ${limit.toLocaleString()} limit. Shorten it.`,
        blocking: true
      }
    ]
  }
  return []
}

export interface ReviewedItem {
  text: string
  problems: BulkProblem[]
  /** Index of the first item with the same text, when this one repeats it. */
  duplicateOf: number | null
}

/** Every item with its problems, and repeats within the list marked (only the first of each is saved). */
export function reviewItems(texts: string[], kind: BulkKind, lengthProfile: LengthProfileId): ReviewedItem[] {
  const seen = new Map<string, number>()
  return texts.map((text, i) => {
    const problems = bulkItemProblems(text, kind, lengthProfile)
    const key = duplicateKey(text)
    const first = key ? seen.get(key) : undefined
    if (key && first === undefined) seen.set(key, i)
    return { text, problems, duplicateOf: first ?? null }
  })
}
