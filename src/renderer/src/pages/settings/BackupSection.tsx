import { ArchiveRestore, CircleCheck, CircleX, FolderOpen, FolderPen, History, HardDriveDownload } from 'lucide-react'
import { useState } from 'react'
import type { BackupSummary } from '@shared/types/storage'
import { Button, Modal, Notice, Select, SettingsRow, SettingsSection, Skeleton, Switch, useToast } from '@/components/ui'
import { useAsync } from '@/hooks/useAsync'
import { errorMessage, relay } from '@/lib/bridge'
import { formatBytes, formatDateTime, formatNumber, formatRelative } from '@/lib/format'

export const RESTORED_FLAG = 'axora.restored'

/**
 * Settings → Backup & restore. A backup is one file with the database and the
 * image library, checked after writing. A restore takes a safety backup first
 * and changes nothing if any step fails.
 */
export function BackupSection() {
  const toast = useToast()
  const status = useAsync(() => relay.backup.status(), [])
  const recovery = useAsync(() => relay.backup.listRecovery(), [])
  const [working, setWorking] = useState<string | null>(null)
  const [candidate, setCandidate] = useState<{ token: string; summary: BackupSummary } | null>(null)

  const run = async (name: string, action: () => Promise<unknown>) => {
    setWorking(name)
    try {
      await action()
    } finally {
      setWorking(null)
      status.reload()
      recovery.reload()
    }
  }

  const backupNow = () =>
    run('backup', async () => {
      try {
        const r = await relay.backup.create()
        if (r.status === 'created') toast({ tone: 'success', title: 'Backup completed successfully', description: `${r.fileName} · ${formatBytes(r.sizeBytes)}` })
      } catch (error) {
        toast({ tone: 'danger', title: 'Backup failed', description: errorMessage(error), duration: 10000 })
      }
    })

  const inspect = (source: 'file' | string) =>
    run(source, async () => {
      try {
        const r = source === 'file' ? await relay.backup.inspectFile() : await relay.backup.inspectRecovery(source)
        if (r.status === 'valid') setCandidate({ token: r.token, summary: r.summary })
        else if (r.status === 'invalid') toast({ tone: 'danger', title: 'This backup can’t be restored', description: r.reason, duration: 10000 })
      } catch (error) {
        toast({ tone: 'danger', title: 'The backup could not be checked', description: errorMessage(error) })
      }
    })

  const s = status.data
  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-medium text-fg">Backup & restore</h2>
        <p className="text-sm text-fg-subtle text-pretty">A backup is one file with all your Axora Relay data and images. Each one is checked after it is written.</p>
      </div>

      {!s ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <SettingsSection title="Back up">
            <SettingsRow
              label="Back up now"
              description={
                s.lastResult && !s.lastResult.ok ? (
                  <span className="flex items-center gap-1 text-danger">
                    <CircleX size={12} /> Last backup failed {formatRelative(s.lastResult.at)}: {s.lastResult.error}
                  </span>
                ) : s.lastBackupAt ? (
                  <span className="flex items-center gap-1">
                    <CircleCheck size={12} className="text-success" /> Last backup {formatRelative(s.lastBackupAt)} ({formatDateTime(s.lastBackupAt)})
                  </span>
                ) : (
                  'No backup yet.'
                )
              }
              control={
                <Button variant="primary" icon={HardDriveDownload} loading={working === 'backup' || s.busy === 'backup'} disabled={Boolean(s.busy)} onClick={backupNow}>
                  Back up now
                </Button>
              }
            />
            <SettingsRow
              label="Save backups in"
              description={<span data-selectable className="break-all">{s.settings.folder}</span>}
              control={
                <span className="flex gap-1.5">
                  <Button size="sm" variant="ghost" icon={FolderOpen} onClick={() => void relay.backup.openFolder()}>
                    Open
                  </Button>
                  <Button
                    size="sm"
                    icon={FolderPen}
                    onClick={() =>
                      run('folder', async () => {
                        try {
                          const next = await relay.backup.chooseFolder()
                          if (next) toast({ tone: 'success', title: 'Backup folder changed' })
                        } catch (error) {
                          toast({ tone: 'danger', title: 'Folder not changed', description: errorMessage(error) })
                        }
                      })
                    }
                  >
                    Change…
                  </Button>
                </span>
              }
            />
            <SettingsRow
              label="Automatic backups"
              htmlFor="backup-schedule"
              description="While Axora Relay is running. Older automatic backups are removed; backups you make yourself are kept."
              control={
                <span className="flex items-center gap-2">
                  <Select<'off' | 'daily' | 'weekly'>
                    id="backup-schedule"
                    size="sm"
                    className="w-28"
                    value={s.settings.schedule}
                    onChange={(schedule) => run('schedule', () => relay.backup.updateSettings({ schedule }))}
                    options={[
                      { value: 'off', label: 'Off' },
                      { value: 'daily', label: 'Daily' },
                      { value: 'weekly', label: 'Weekly' }
                    ]}
                  />
                  {s.settings.schedule !== 'off' && (
                    <Select<string>
                      size="sm"
                      className="w-32"
                      aria-label="Automatic backups to keep"
                      value={String(s.settings.keep)}
                      onChange={(keep) => run('keep', () => relay.backup.updateSettings({ keep: Number(keep) }))}
                      options={[3, 7, 14, 30].map((n) => ({ value: String(n), label: `Keep ${n}` }))}
                    />
                  )}
                </span>
              }
            />
          </SettingsSection>

          <Notice title="What a backup contains">
            Drafts, schedules, the task queue, post links and engagement tasks, account records, AI usage history, settings and your image library.{' '}
            <span className="text-fg-subtle">Not included: {s.notIncluded.join('; ')}.</span>
          </Notice>
        </>
      )}

      <SettingsSection title="Restore" description="Replaces your current data with a backup. A safety backup of the current data is made first.">
        <SettingsRow
          label="Restore from a backup"
          description="Choose an Axora Relay backup file (.axrbackup, or an older .sqlite backup)."
          control={
            <Button icon={ArchiveRestore} loading={working === 'file'} disabled={Boolean(s?.busy)} onClick={() => inspect('file')}>
              Choose backup…
            </Button>
          }
        />
        <div className="flex items-center gap-2 border-t border-line px-4 pb-1 pt-3">
          <History size={13} className="text-fg-subtle" />
          <span className="text-xs font-medium text-fg-muted">Safety backups</span>
          <span className="text-2xs text-fg-faint">made before each restore</span>
        </div>
        {(recovery.data ?? []).length === 0 ? (
          <p className="px-4 pb-3 text-xs text-fg-subtle">None yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {recovery.data!.map((item) => (
              <li key={item.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm text-fg">{formatDateTime(item.createdAt)}</span>
                  <span className="text-xs text-fg-subtle">
                    {formatRelative(item.createdAt)} · {formatBytes(item.sizeBytes)}
                    {item.fileName.endsWith('.sqlite') ? ' · data only' : ''}
                  </span>
                </div>
                <Button size="sm" loading={working === item.id} disabled={Boolean(s?.busy)} onClick={() => inspect(item.id)}>
                  Restore…
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>

      <RestoreDialog candidate={candidate} onClose={() => setCandidate(null)} />
    </>
  )
}

function RestoreDialog({ candidate, onClose }: { candidate: { token: string; summary: BackupSummary } | null; onClose: () => void }) {
  const toast = useToast()
  const [understood, setUnderstood] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const s = candidate?.summary
  const close = () => {
    setUnderstood(false)
    onClose()
  }
  const restore = async () => {
    if (!candidate) return
    setRestoring(true)
    try {
      await relay.backup.restore(candidate.token)
      try {
        sessionStorage.setItem(RESTORED_FLAG, candidate.summary.fileName)
      } catch {
        // The reload still shows restored data.
      }
      window.location.reload()
    } catch (error) {
      toast({ tone: 'danger', title: 'Restore failed — your data was not changed', description: errorMessage(error), duration: 10000 })
      setRestoring(false)
      close()
    }
  }
  const count = (key: string) => formatNumber(s?.counts[key] ?? 0)
  return (
    <Modal
      open={Boolean(candidate)}
      onClose={close}
      dismissible={!restoring}
      title="Restore this backup?"
      description="The backup was checked and can be restored."
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={restoring}>
            Cancel
          </Button>
          <Button variant="danger" disabled={!understood} loading={restoring} onClick={restore}>
            Replace current data
          </Button>
        </>
      }
    >
      {s && (
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-md border border-line bg-surface-2 p-4 text-sm">
            {[
              ['Made', formatDateTime(s.createdAt ?? s.modifiedAt)],
              ['Size', formatBytes(s.sizeBytes)],
              ['Drafts', count('drafts')],
              ['Scheduled posts', count('schedules')],
              ['Post links', count('links')],
              ['Accounts', count('accounts')],
              ['Images', s.includesImages ? formatNumber(s.images ?? 0) : 'Not included'],
              ['AI usage records', count('usageRecords')]
            ].map(([label, value]) => (
              <div key={label} className="flex min-w-0 flex-col gap-0.5">
                <dt className="text-xs text-fg-subtle">{label}</dt>
                <dd className="truncate text-fg">{value}</dd>
              </div>
            ))}
          </dl>
          {!s.includesImages && <Notice tone="warning" title="This is an older backup without images">Your current images stay as they are.</Notice>}
          <Notice tone="warning" title="Your current data will be replaced">
            Publishing pauses during the restore. A safety backup of everything as it is now is made first — you can restore it from Safety backups. API keys and
            proxy passwords stay as they are on this computer.
          </Notice>
          <label className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2.5">
            <span className="text-sm text-fg">I understand this replaces my current data</span>
            <Switch checked={understood} onChange={setUnderstood} aria-label="Confirm replacing current data" />
          </label>
        </div>
      )}
    </Modal>
  )
}
