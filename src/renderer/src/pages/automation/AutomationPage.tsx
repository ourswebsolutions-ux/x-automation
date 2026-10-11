import { BookmarkPlus, History, RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import type { AutomationConfig } from '@shared/types/automation'
import { Button, ConfirmDialog, Field, IconButton, Input, Modal, PageHeader, Select, StatusBadge, useToast } from '@/components/ui'
import { useActiveRun, usePresets, useRuns } from '@/data/automation'
import { errorMessage, relay } from '@/lib/bridge'
import { formatDateTime } from '@/lib/format'
import { NAV_ITEMS } from '@/app/navigation'
import { ConfigForm } from './ConfigForm'
import { defaultConfig, loadDraftConfig, saveDraftConfig } from './defaults'
import { PlanPanel } from './PlanPanel'
import { RunPanel } from './RunPanel'

/** Create automation: describe the posts, choose profiles and actions, check the summary, start once. */
export function AutomationPage() {
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const [config, setConfig] = useState<AutomationConfig>(() => loadDraftConfig())
  const [presetId, setPresetId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [presetName, setPresetName] = useState('')
  const [deleting, setDeleting] = useState(false)
  const presets = usePresets()
  const active = useActiveRun()
  const runs = useRuns()
  const viewRun = params.get('run') ?? active.data?.id ?? null

  useEffect(() => saveDraftConfig(config), [config])
  // ?preset=<id> (from the dashboard) loads that preset.
  useEffect(() => {
    const wanted = params.get('preset')
    const preset = wanted ? presets.data?.find((p) => p.id === wanted) : null
    if (preset) {
      setConfig(preset.config)
      setPresetId(preset.id)
      setParams((p) => (p.delete('preset'), p), { replace: true })
    }
  }, [params, presets.data, setParams])

  const loadPreset = (id: string) => {
    const preset = presets.data?.find((p) => p.id === id)
    if (!preset) return
    setConfig(preset.config)
    setPresetId(preset.id)
    toast({ tone: 'info', title: `Loaded “${preset.name}”` })
  }

  const savePreset = async () => {
    try {
      const preset = await relay.presets.save({ ...(presetId && presets.data?.find((p) => p.id === presetId)?.name === presetName.trim() ? { id: presetId } : {}), name: presetName.trim(), config: { ...config, name: presetName.trim() } })
      setPresetId(preset.id)
      setConfig(preset.config)
      setSaving(false)
      presets.reload()
      toast({ tone: 'success', title: 'Preset saved' })
    } catch (e) {
      toast({ tone: 'danger', title: 'Preset not saved', description: errorMessage(e) })
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={NAV_ITEMS.automation.label}
        description="Describe the posts you want, choose profiles and actions, and start once."
        actions={
          <>
            {(presets.data?.length ?? 0) > 0 && (
              <Select<string>
                className="w-52"
                aria-label="Presets"
                value={presetId}
                placeholder="Load a preset…"
                onChange={loadPreset}
                options={presets.data!.map((p) => ({ value: p.id, label: p.name }))}
              />
            )}
            {presetId && <IconButton icon={Trash2} label="Delete preset" onClick={() => setDeleting(true)} />}
            <Button
              icon={BookmarkPlus}
              onClick={() => {
                setPresetName(presets.data?.find((p) => p.id === presetId)?.name ?? config.name)
                setSaving(true)
              }}
            >
              Save as preset
            </Button>
            <IconButton
              icon={RotateCcw}
              label="Start over"
              onClick={() => {
                setConfig(defaultConfig())
                setPresetId(null)
              }}
            />
          </>
        }
      />

      {viewRun && <RunPanel runId={viewRun} />}

      <div className="grid grid-cols-1 gap-4 @5xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex flex-col gap-4">
          <Field label="Name" htmlFor="auto-name">
            <Input id="auto-name" value={config.name} maxLength={80} onChange={(e) => setConfig({ ...config, name: e.target.value })} />
          </Field>
          <ConfigForm config={config} onChange={setConfig} />
        </div>
        <PlanPanel config={{ ...config, name: config.name.trim() || 'Automation' }} presetId={presetId} activeRun={active.data ?? null} onStarted={(run) => setParams({ run: run.id }, { replace: true })} />
      </div>

      {(runs.data?.length ?? 0) > 0 && (
        <section aria-label="Recent runs" className="flex flex-col gap-2">
          <h2 className="flex items-center gap-2 text-sm font-medium text-fg">
            <History size={14} className="text-fg-subtle" /> Recent runs
          </h2>
          <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface-2">
            {runs.data!.slice(0, 8).map((r) => (
              <li key={r.id}>
                <button type="button" className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-3" onClick={() => setParams({ run: r.id }, { replace: true })}>
                  <span className="min-w-0 flex-1 truncate text-sm text-fg">{r.name}</span>
                  <span className="text-xs text-fg-subtle">{r.mode === 'full-auto' ? 'Full Auto' : 'Manual Approval'}</span>
                  <span className="text-xs text-fg-subtle">{r.counts.published} published</span>
                  <StatusBadge tone={r.status === 'completed' ? 'success' : r.status === 'paused' || r.status === 'awaiting-approval' ? 'warning' : 'neutral'}>{r.status === 'awaiting-approval' ? 'Waiting for approval' : r.status[0]!.toUpperCase() + r.status.slice(1)}</StatusBadge>
                  <span className="tabular w-32 text-right text-xs text-fg-subtle">{formatDateTime(r.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Modal
        open={saving}
        onClose={() => setSaving(false)}
        size="sm"
        title="Save as preset"
        description="Saves the instructions and every setting on this page."
        footer={
          <>
            <Button variant="ghost" onClick={() => setSaving(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!presetName.trim()} onClick={savePreset}>
              Save preset
            </Button>
          </>
        }
      >
        <Field label="Preset name" htmlFor="preset-name">
          <Input id="preset-name" value={presetName} maxLength={80} onChange={(e) => setPresetName(e.target.value)} />
        </Field>
      </Modal>
      <ConfirmDialog
        open={deleting}
        title="Delete this preset?"
        description="Runs started from it are kept."
        confirmLabel="Delete"
        tone="danger"
        onCancel={() => setDeleting(false)}
        onConfirm={async () => {
          setDeleting(false)
          if (!presetId) return
          try {
            await relay.presets.remove(presetId)
            setPresetId(null)
            presets.reload()
          } catch (e) {
            toast({ tone: 'danger', title: 'Not deleted', description: errorMessage(e) })
          }
        }}
      />
    </div>
  )
}
