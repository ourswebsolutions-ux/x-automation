import { FolderOpen, HardDrive, Image as ImageIcon, Plus, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { X_MEDIA_LIMITS } from '@shared/config/mediaLimits'
import type { ProviderConfig } from '@shared/types/providers'
import { Button, ConfirmDialog, EmptyState, ErrorState, Notice, Select, SettingsRow, SettingsSection, SkeletonRows, useToast } from '@/components/ui'
import { useAiOverview } from '@/data/ai'
import { useCredentialStatus, useProviders } from '@/data/providers'
import { useAsync } from '@/hooks/useAsync'
import { errorMessage, relay } from '@/lib/bridge'
import { formatBytes, formatNumber } from '@/lib/format'
import { usePreferences } from '@/state/preferences'
import { ProviderRow } from './AiProvidersSection'
import { ImageProviderDialog } from './ai/ImageProviderDialog'

export function ImageSection() {
  const toast = useToast()
  const { preferences, update } = usePreferences()
  const providers = useProviders('image')
  const credentials = useCredentialStatus()
  const overview = useAiOverview()
  const stats = useAsync(() => relay.assets.stats(), [])
  const [dialog, setDialog] = useState<{ open: boolean; provider: ProviderConfig | null }>({ open: false, provider: null })
  const [pendingRemove, setPendingRemove] = useState<ProviderConfig | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const list = providers.data ?? []
  const enabled = list.filter((p) => p.enabled)
  const tests = overview.data?.tests ?? {}
  const { reload } = stats
  useEffect(() => relay.integrations.onChange(reload), [reload])

  const test = async (p: ProviderConfig) => {
    setTesting(p.id)
    try {
      const r = await relay.ai.testConnection(p.id)
      toast(r.ok ? { tone: 'success', title: `“${p.name}” is connected`, description: `${r.modelCount} models listed · ${r.latencyMs} ms` } : { tone: 'danger', title: `“${p.name}” failed the test`, description: `${r.error?.message ?? ''} ${r.error?.hint ?? ''}`.trim(), duration: 9000 })
    } catch (error) {
      toast({ tone: 'danger', title: 'Connection test failed', description: errorMessage(error) })
    } finally {
      setTesting(null)
    }
  }
  const editing = dialog.provider ? (list.find((p) => p.id === dialog.provider!.id) ?? dialog.provider) : null

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-medium text-fg">Image generation</h2>
        <p className="text-sm text-fg-subtle text-pretty">
          Providers that create images for posts — separate from AI text providers. Models, sizes, quality and formats offered here are the ones each model
          documents; nothing is assumed. A provider shows as connected only after a real request succeeds.
        </p>
      </div>

      <div className="rounded-lg border border-line bg-surface-2">
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <span className="text-xs text-fg-subtle">{providers.data ? `${list.length} provider${list.length === 1 ? '' : 's'}` : 'Loading…'}</span>
          <Button size="sm" variant="primary" icon={Plus} onClick={() => setDialog({ open: true, provider: null })}>
            Add image provider
          </Button>
        </div>
        {providers.status === 'error' ? (
          <ErrorState size="sm" error={providers.error} onRetry={providers.reload} />
        ) : !providers.data ? (
          <SkeletonRows rows={2} className="p-4" />
        ) : list.length === 0 ? (
          <EmptyState
            size="sm"
            icon={ImageIcon}
            title="No image providers yet"
            description="Add OpenAI’s Images API with your key. Uploading your own images works without one."
            actions={
              <Button size="sm" icon={Plus} onClick={() => setDialog({ open: true, provider: null })}>
                Add image provider
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-line">
            {list.map((p) => (
              <ProviderRow
                key={p.id}
                provider={p}
                test={tests[p.id]}
                isDefault={p.id === preferences.defaults.imageProviderId}
                testing={testing === p.id}
                onTest={() => test(p)}
                onEdit={() => setDialog({ open: true, provider: p })}
                onRemove={() => setPendingRemove(p)}
                onToggle={async (next) => {
                  try {
                    await relay.providers.update(p.id, { kind: p.kind, name: p.name, endpoint: p.endpoint, model: p.model, enabled: next })
                  } catch (error) {
                    toast({ tone: 'danger', title: 'Could not update', description: errorMessage(error) })
                  }
                }}
              />
            ))}
          </ul>
        )}
      </div>

      <SettingsSection title="Defaults">
        <SettingsRow
          label="Default image provider"
          htmlFor="default-image"
          description="Used by the image panel in the editor. Size, quality and format defaults are set per provider."
          control={
            <Select<string>
              id="default-image"
              className="w-64"
              value={preferences.defaults.imageProviderId ?? 'none'}
              onChange={(value) => update({ defaults: { imageProviderId: value === 'none' ? null : value } })}
              options={[{ value: 'none', label: 'None' }, ...enabled.map((p) => ({ value: p.id, label: p.name, description: p.model ?? undefined }))]}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Image library" description="Uploaded and generated images are stored on this device, in a folder Axora Relay manages. Only metadata is kept in the database.">
        <SettingsRow
          label="Storage location"
          description={<span data-selectable className="font-mono text-2xs">{stats.data?.folder ?? '…'}</span>}
          control={
            <Button size="sm" icon={FolderOpen} onClick={() => void relay.assets.openFolder()}>
              Open folder
            </Button>
          }
        />
        <SettingsRow
          label="Library size"
          description="Generated images you don’t save or attach are removed after 7 days. Database backups contain image metadata only, not the files."
          control={
            <span className="flex items-center gap-1.5 text-sm text-fg-muted">
              <HardDrive size={13} /> {stats.data ? `${formatNumber(stats.data.count)} images · ${formatBytes(stats.data.bytes)}` : '…'}
            </span>
          }
        />
      </SettingsSection>

      <Notice icon={ShieldCheck} title="Attachment limits (verified with X’s documentation)">
        JPEG, PNG, GIF and WEBP · up to {X_MEDIA_LIMITS.maxImageBytes / 1024 / 1024} MB per image · animated GIFs up to {X_MEDIA_LIMITS.maxAnimatedGifBytes / 1024 / 1024} MB and on
        their own · up to {X_MEDIA_LIMITS.maxPhotos} images per post · descriptions up to {X_MEDIA_LIMITS.maxAltTextChars} characters. Files are checked by their content,
        not their name; larger files are refused at import.{' '}
        <button type="button" className="rounded-xs text-accent-text hover:underline focus-ring" onClick={() => void relay.shell.openExternal(X_MEDIA_LIMITS.sources.media)}>
          Source
        </button>
      </Notice>


      <ImageProviderDialog
        open={dialog.open}
        provider={editing}
        test={editing ? tests[editing.id] : undefined}
        credentials={credentials.data}
        onClose={() => setDialog((d) => ({ ...d, open: false }))}
        onSaved={(saved) => {
          providers.reload()
          setDialog({ open: true, provider: saved })
        }}
      />
      <ConfirmDialog
        open={Boolean(pendingRemove)}
        title={`Remove “${pendingRemove?.name ?? ''}”?`}
        description="The configuration and its encrypted key are deleted. Generated images in the library and usage history stay."
        confirmLabel="Remove provider"
        tone="danger"
        onCancel={() => setPendingRemove(null)}
        onConfirm={async () => {
          if (pendingRemove) {
            try {
              await relay.providers.remove(pendingRemove.id)
            } catch (error) {
              toast({ tone: 'danger', title: 'Could not remove', description: errorMessage(error) })
            }
          }
          setPendingRemove(null)
        }}
      />
    </>
  )
}
