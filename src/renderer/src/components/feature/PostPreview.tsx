import { Fragment } from 'react'
import { cn } from '@/lib/cn'
import type { MediaAttachment } from '@shared/types/domain'
import { AccountAvatar } from './AccountAvatar'
import { AssetThumb } from './AssetThumb'

const TOKEN = /(https?:\/\/[^\s]+|#[\p{L}\p{N}_]+|@[A-Za-z0-9_]{1,15})/gu

/** Highlights links, hashtags and mentions the way a post renders them. */
function Highlighted({ text }: { text: string }) {
  const parts = text.split(TOKEN)
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="text-info">
            {part}
          </span>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        )
      )}
    </>
  )
}

interface PostPreviewProps {
  text: string
  name: string
  handle: string | null
  media?: MediaAttachment[]
  className?: string
}

/** A neutral preview of how the post reads — not a copy of X’s interface. */
export function PostPreview({ text, name, handle, media = [], className }: PostPreviewProps) {
  return (
    <div className={cn('flex gap-3 rounded-md border border-line bg-surface-1 p-3.5', className)}>
      <AccountAvatar name={name} handle={handle ?? name} size={32} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-baseline gap-1.5 text-sm">
          <span className="truncate font-medium text-fg">{name}</span>
          {handle && <span className="truncate text-fg-subtle">@{handle}</span>}
        </span>
        {text.trim() ? (
          <p data-selectable className="whitespace-pre-wrap break-words text-sm leading-relaxed text-fg">
            <Highlighted text={text} />
          </p>
        ) : (
          !media.length && <p className="text-sm text-fg-faint">Your post will appear here.</p>
        )}
        {media.length > 0 && (
          <div
            aria-label="Attached images"
            className={cn(
              'mt-1.5 grid aspect-[16/9] w-full max-w-md gap-0.5 overflow-hidden rounded-md border border-line',
              media.length === 1 ? 'grid-cols-1' : 'grid-cols-2',
              media.length >= 3 && 'grid-rows-2'
            )}
          >
            {media.map((m, i) => (
              <AssetThumb
                key={m.id}
                url={m.url}
                alt={m.altText || `Image ${i + 1}`}
                available={m.available}
                className={cn('size-full min-h-0', media.length === 3 && i === 0 && 'row-span-2')}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
