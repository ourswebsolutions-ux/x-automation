import { LENGTH_PROFILES } from '@shared/config/postLimits'
import type { AssistRequest, GenerationBrief, PostLength, Tone } from '@shared/types/generator'

/**
 * Prompt construction for the generator and editing tools. Prompts ask for a
 * small JSON object so several variations come back from one (billed) request
 * and can be parsed reliably across providers.
 */

export interface BuiltPrompt {
  instructions: string
  input: string
  /** Key of the JSON array to read: "variations" or "hashtags". */
  key: 'variations' | 'hashtags'
  expected: number
}

const TARGET: Record<PostLength, (limit: number) => number> = {
  short: (limit) => Math.min(120, limit),
  medium: (limit) => Math.min(200, limit),
  long: (limit) => (limit > 280 ? 1200 : limit)
}

const TONE_GUIDE: Record<Tone, string> = {
  professional: 'professional and credible',
  informative: 'informative and factual',
  conversational: 'conversational and warm',
  educational: 'educational, explaining clearly',
  humorous: 'light and humorous without being offensive',
  promotional: 'promotional but not spammy',
  inspirational: 'inspirational and uplifting'
}

const BASE_RULES = [
  'You write posts for X (formerly Twitter).',
  'Do not invent facts, statistics, quotes, names, prices, dates or links that are not in the user’s material.',
  'Plain text only: no markdown, no surrounding quotation marks, no numbering, no explanations.'
]

const jsonRule = (key: 'variations' | 'hashtags', n: number) =>
  key === 'variations'
    ? `Respond with only a JSON object of the form {"variations": ["…"]} containing exactly ${n} different post${n === 1 ? '' : 's'}.`
    : `Respond with only a JSON object of the form {"hashtags": ["…"]} containing up to ${n} hashtags without the # sign.`

const block = (label: string, text: string) => `${label}:\n<<<\n${text.trim()}\n>>>`

export function buildGenerationPrompt(brief: GenerationBrief): BuiltPrompt {
  const limit = LENGTH_PROFILES[brief.lengthProfile].maxWeighted
  const target = TARGET[brief.length](limit)
  const instructions = [
    ...BASE_RULES,
    `Write in ${brief.language}. Tone: ${TONE_GUIDE[brief.tone]}.`,
    `Each post must be at most ${target} characters, counting any hashtags; links count as 23 characters. Never exceed ${limit}.`,
    brief.hashtags.length
      ? `End each post with these hashtags: ${brief.hashtags.map((t) => `#${t}`).join(' ')}.${brief.suggestHashtags ? ' You may add up to two more fitting hashtags.' : ''}`
      : brief.suggestHashtags
        ? 'Add one to three fitting hashtags at the end of each post.'
        : 'Do not add hashtags.',
    brief.callToAction.trim() ? 'Close with the call to action provided, adapted naturally to each post.' : 'Do not add a call to action unless the material asks for one.',
    'Make the variations genuinely different in angle or structure.',
    jsonRule('variations', brief.variations)
  ].join('\n')

  const parts = [
    brief.topic.trim() && block('Topic', brief.topic),
    brief.keyPoints.trim() && block('Main message / key points', brief.keyPoints),
    brief.audience.trim() && block('Intended audience', brief.audience),
    brief.callToAction.trim() && block('Call to action', brief.callToAction),
    brief.instructions.trim() && block('Additional instructions from the user', brief.instructions)
  ].filter(Boolean)
  return { instructions, input: parts.join('\n\n'), key: 'variations', expected: brief.variations }
}

const TOOL_TASK: Record<AssistRequest['tool'], (r: AssistRequest) => string> = {
  rewrite: () => 'Rewrite the post with fresh wording while keeping its meaning, language and facts.',
  improve: () => 'Improve clarity, grammar, spelling and flow. Keep the meaning, voice and language; change as little as needed.',
  shorten: () => 'Make the post noticeably shorter while keeping its key message and language.',
  expand: () => 'Expand the post with more helpful detail drawn only from what it already says. Do not add new facts.',
  tone: (r) => `Rewrite the post in a ${TONE_GUIDE[r.tone ?? 'professional']} tone. Keep the meaning, facts and language.`,
  translate: (r) => `Translate the post into ${r.language}. Keep the meaning, tone, names, links and hashtags.`,
  alternatives: () => 'Write alternative versions of the post with different angles or structures, keeping the facts and language.',
  hashtags: () => 'Suggest relevant hashtags for the post: specific and commonly used, not generic filler. Do not repeat hashtags it already uses.',
  opening: () => 'Improve only the opening sentence so it hooks the reader; keep the rest of the post as it is.',
  cta: () => 'Refine the call to action (or add a natural one if missing) at the end; keep the rest of the post as it is.'
}

export function buildAssistPrompt(request: AssistRequest): BuiltPrompt {
  const limit = LENGTH_PROFILES[request.lengthProfile].maxWeighted
  const hashtags = request.tool === 'hashtags'
  const n = hashtags ? 8 : request.tool === 'alternatives' ? (request.variations ?? 3) : (request.variations ?? 1)
  const instructions = [
    ...BASE_RULES,
    TOOL_TASK[request.tool](request),
    hashtags ? '' : `Each result must be at most ${limit} characters; links count as 23. Leave any hashtags in the text as they are and do not add new ones.`,
    jsonRule(hashtags ? 'hashtags' : 'variations', n)
  ]
    .filter(Boolean)
    .join('\n')
  const parts = [block('Post', request.text)]
  if (request.hashtags.length) parts.push(`Hashtags already attached: ${request.hashtags.map((t) => `#${t}`).join(' ')}`)
  return { instructions, input: parts.join('\n\n'), key: hashtags ? 'hashtags' : 'variations', expected: n }
}
