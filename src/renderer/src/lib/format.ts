const relativeFormatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'short' })
const numberFormatter = new Intl.NumberFormat('en')
const dateTimeFormatter = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
})
const timeFormatter = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const longDateFormatter = new Intl.DateTimeFormat('en', { weekday: 'long', month: 'long', day: 'numeric' })

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60]
]

export function formatRelative(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000)
  if (Math.abs(seconds) < 45) return 'just now'
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size || unit === 'minute') {
      return relativeFormatter.format(Math.round(seconds / size), unit)
    }
  }
  return 'just now'
}

export const formatNumber = (value: number) => numberFormatter.format(value)
export const formatDateTime = (iso: string) => dateTimeFormatter.format(new Date(iso))
export const formatTime = (iso: string) => timeFormatter.format(new Date(iso))
export const formatLongDate = (date = new Date()) => longDateFormatter.format(date)

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${formatNumber(count)} ${count === 1 ? singular : plural}`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
