import { ImageOff } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/cn'

interface AssetThumbProps {
  url: string
  alt: string
  available: boolean
  className?: string
  fit?: 'cover' | 'contain'
}

/** A library image. Missing or undecodable files show a clear placeholder instead of a broken image. */
export function AssetThumb({ url, alt, available, className, fit = 'cover' }: AssetThumbProps) {
  const [broken, setBroken] = useState(false)
  if (!available || broken) {
    return (
      <div role="img" aria-label={`${alt} (file missing)`} className={cn('grid place-items-center gap-1 bg-surface-3 text-center text-fg-faint', className)}>
        <span className="flex flex-col items-center gap-1 px-2 text-2xs">
          <ImageOff size={16} />
          {available ? 'Can’t display' : 'File missing'}
        </span>
      </div>
    )
  }
  return <img src={url} alt={alt} loading="lazy" draggable={false} onError={() => setBroken(true)} className={cn('bg-surface-3', fit === 'cover' ? 'object-cover' : 'object-contain', className)} />
}
