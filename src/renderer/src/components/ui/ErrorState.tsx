import { RotateCw, TriangleAlert } from 'lucide-react'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { errorMessage } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { Button } from './Button'

interface ErrorStateProps {
  title?: string
  error?: unknown
  onRetry?: () => void
  size?: 'sm' | 'md'
  className?: string
}

export function ErrorState({ title = 'Something went wrong', error, onRetry, size = 'md', className }: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-3 text-center animate-fade-in',
        size === 'sm' ? 'px-4 py-8' : 'px-6 py-14',
        className
      )}
    >
      <span className="grid size-10 place-items-center rounded-lg border border-danger/25 bg-danger-soft text-danger">
        <TriangleAlert size={17} strokeWidth={1.7} />
      </span>
      <div className="flex max-w-md flex-col gap-1">
        <p className="text-sm font-medium text-fg">{title}</p>
        {error !== undefined && (
          <p data-selectable className="font-mono text-xs text-fg-subtle break-words">
            {errorMessage(error)}
          </p>
        )}
      </div>
      {onRetry && (
        <Button size="sm" icon={RotateCw} onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}

interface BoundaryProps {
  children: ReactNode
  /** Changing this value clears a caught error (e.g. the current route). */
  resetKey?: unknown
}

export class ErrorBoundary extends Component<BoundaryProps, { error: unknown }> {
  override state: { error: unknown } = { error: null }

  static getDerivedStateFromError(error: unknown) {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Render error', error, info.componentStack)
    window.relay?.logs.write('error', 'render', error.message).catch(() => undefined)
  }

  override componentDidUpdate(prev: BoundaryProps) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }

  override render() {
    if (this.state.error) {
      return (
        <ErrorState
          title="This view failed to render"
          error={this.state.error}
          onRetry={() => this.setState({ error: null })}
        />
      )
    }
    return this.props.children
  }
}
