import { ImagePlus, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { imageModelCapabilities } from '@shared/config/imageModels'
import type { AutomationConfig } from '@shared/types/automation'
import { LANGUAGES, TONES } from '@shared/types/generator'
import { IMAGE_STYLES } from '@shared/types/images'
import { Button, Field, Input, SegmentedControl, Select, Switch, Textarea } from '@/components/ui'
import { AssetLibraryDialog } from '@/components/feature/AssetLibraryDialog'
import { AssetThumb } from '@/components/feature/AssetThumb'
import { HashtagInput } from '@/components/feature/HashtagInput'
import { ProviderModelSelect } from '@/components/feature/ProviderModelSelect'
import { useProviders } from '@/data/providers'
import { DraftPicker } from './DraftPicker'
import { ProfileTargets } from './ProfileTargets'

interface Props {
  config: AutomationConfig
  onChange: (next: AutomationConfig) => void
}

function Section({ step, title, description, children }: { step: number; title: string; description?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-4 rounded-lg border border-line bg-surface-2 px-5 py-4">
      <header className="flex items-baseline gap-3">
        <span className="tabular text-2xs font-medium text-accent-text">{String(step).padStart(2, '0')}</span>
        <span className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium text-fg">{title}</h2>
          {description && <p className="text-xs text-fg-subtle">{description}</p>}
        </span>
      </header>
      {children}
    </section>
  )
}

function Toggle({ label, description, checked, onChange }: { label: string; description?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span className="flex flex-col">
        <span className="text-fg">{label}</span>
        {description && <span className="text-xs text-fg-subtle">{description}</span>}
      </span>
      <Switch checked={checked} onChange={onChange} aria-label={label} />
    </label>
  )
}

const pad = (n: number) => String(n).padStart(2, '0')
const toLocalInput = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const fromLocalInput = (value: string) => (value ? new Date(value).toISOString() : null)
const num = (value: string, min: number, max: number, fallback: number) => {
  const n = Number(value)
  return Number.isInteger(n) ? Math.min(Math.max(n, min), max) : fallback
}

/** The automation wizard: everything a run needs, in the order people think about it. */
export function ConfigForm({ config, onChange }: Props) {
  const providers = useProviders()
  const textProviders = (providers.data ?? []).filter((p) => p.kind === 'openai-compatible' && p.enabled)
  const imageProviders = (providers.data ?? []).filter((p) => p.kind === 'image' && p.enabled)
  const [library, setLibrary] = useState(false)
  const { content, targets, actions, schedule, failure } = config
  const set = (patch: Partial<AutomationConfig>) => onChange({ ...config, ...patch })
  const setContent = (patch: Partial<AutomationConfig['content']>) => set({ content: { ...content, ...patch } })
  const setActions = (patch: Partial<AutomationConfig['actions']>) => set({ actions: { ...actions, ...patch } })
  const setSchedule = (patch: Partial<AutomationConfig['schedule']>) => set({ schedule: { ...schedule, ...patch } })
  const setFailure = (patch: Partial<AutomationConfig['failure']>) => set({ failure: { ...failure, ...patch } })
  const imageProvider = imageProviders.find((p) => p.id === content.imageProviderId) ?? imageProviders[0]
  const sizes = imageModelCapabilities(content.imageModel ?? imageProvider?.model ?? null).sizes
  const publishing = actions.publish && targets.distribution !== 'drafts'

  return (
    <div className="flex flex-col gap-4">
      <Section
        step={1}
        title="What to post"
        description={content.source === 'drafts' ? 'Your own drafts are posted as you wrote them.' : 'Describe the posts you want. Every post is written fresh and checked against X’s length limit.'}
      >
        <SegmentedControl<AutomationConfig['content']['source']>
          value={content.source}
          onChange={(source) => setContent({ source })}
          options={[
            { value: 'generate', label: 'Generate with AI' },
            { value: 'drafts', label: 'My drafts' },
            { value: 'mixed', label: 'My drafts + AI' }
          ]}
        />
        {content.source !== 'generate' && <DraftPicker value={content.draftIds} onChange={(draftIds) => setContent({ draftIds })} />}
        {content.source === 'mixed' && <p className="text-xs text-fg-subtle">Your drafts fill the first posts; AI writes the rest from the instructions below.</p>}
        {content.source !== 'drafts' && (
          <>
            <Field label="Your instructions" htmlFor="auto-prompt">
              <Textarea
                id="auto-prompt"
                rows={4}
                value={content.prompt}
                maxLength={4000}
                disabled={!content.generateText}
                placeholder="Generate professional technology posts in English about software development and AI tools."
                onChange={(e) => setContent({ prompt: e.target.value })}
                className="text-base"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
              <Field label="Topic or niche" htmlFor="auto-topic">
                <Input id="auto-topic" value={content.topic} maxLength={200} disabled={!content.generateText} placeholder="Optional" onChange={(e) => setContent({ topic: e.target.value })} />
              </Field>
              <Field label="Language" htmlFor="auto-language">
                <Select<string> id="auto-language" value={content.language} onChange={(language) => setContent({ language })} options={LANGUAGES.map((l) => ({ value: l, label: l }))} />
              </Field>
              <Field label="Tone" htmlFor="auto-tone">
                <Select<string>
                  id="auto-tone"
                  value={content.tone}
                  onChange={(tone) => setContent({ tone: tone as typeof content.tone })}
                  options={TONES.map((t) => ({
                    value: t,
                    label: t[0]!.toUpperCase() + t.slice(1)
                  }))}
                />
              </Field>
              <Field label="Length" htmlFor="auto-length">
                <SegmentedControl<typeof content.length>
                  value={content.length}
                  onChange={(length) => setContent({ length })}
                  options={[
                    { value: 'short', label: 'Short' },
                    { value: 'medium', label: 'Medium' },
                    { value: 'long', label: 'Long' }
                  ]}
                />
              </Field>
            </div>
            <Field label="Hashtags" htmlFor="auto-hashtags" hint="Added to every post unless the text already has them.">
              <HashtagInput id="auto-hashtags" value={content.hashtags} onChange={(hashtags) => setContent({ hashtags })} />
            </Field>
            <Field label="Extra instructions" htmlFor="auto-instructions" aside={<span className="text-2xs text-fg-faint">Optional</span>}>
              <Textarea
                id="auto-instructions"
                rows={2}
                value={content.instructions}
                maxLength={2000}
                placeholder="E.g. no emojis, end with a question"
                onChange={(e) => setContent({ instructions: e.target.value })}
              />
            </Field>
          </>
        )}
        <div className="grid grid-cols-1 gap-4 border-t border-line pt-4 @3xl:grid-cols-2">
          {content.source !== 'drafts' && (
            <div className="flex flex-col gap-3">
              <Toggle label="Generate text with AI" checked={content.generateText} onChange={(generateText) => setContent({ generateText })} />
              {content.generateText ? (
                textProviders.length ? (
                  <ProviderModelSelect
                    providers={textProviders}
                    value={{
                      providerId: content.textProviderId,
                      model: content.textModel
                    }}
                    onChange={(c) =>
                      setContent({
                        textProviderId: c.providerId,
                        textModel: c.model
                      })
                    }
                  />
                ) : (
                  <p className="text-xs text-warning">Add an AI text provider in Settings → AI providers & keys.</p>
                )
              ) : (
                <Field label="Text to post" htmlFor="auto-fixed">
                  <Textarea id="auto-fixed" rows={3} value={content.fixedText} maxLength={25000} onChange={(e) => setContent({ fixedText: e.target.value })} />
                </Field>
              )}
            </div>
          )}
          <div className="flex flex-col gap-3">
            <Toggle
              label={content.source === 'generate' ? 'Generate an image for each post' : 'Generate an image for each post without one'}
              checked={content.generateImages}
              onChange={(generateImages) => setContent({ generateImages })}
            />
            {content.generateImages ? (
              imageProviders.length ? (
                <>
                  <ProviderModelSelect
                    kind="image"
                    providers={imageProviders}
                    value={{
                      providerId: content.imageProviderId,
                      model: content.imageModel
                    }}
                    onChange={(c) =>
                      setContent({
                        imageProviderId: c.providerId,
                        imageModel: c.model
                      })
                    }
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <Select<string>
                      size="sm"
                      aria-label="Image style"
                      value={content.imageStyle}
                      onChange={(imageStyle) =>
                        setContent({
                          imageStyle: imageStyle as typeof content.imageStyle
                        })
                      }
                      options={IMAGE_STYLES.map((s) => ({
                        value: s,
                        label: s[0]!.toUpperCase() + s.slice(1)
                      }))}
                    />
                    <Select<string>
                      size="sm"
                      aria-label="Image size"
                      value={sizes.includes(content.imageSize) ? content.imageSize : sizes[0]!}
                      onChange={(imageSize) => setContent({ imageSize })}
                      options={sizes.map((s) => ({ value: s, label: s }))}
                    />
                  </div>
                </>
              ) : (
                <p className="text-xs text-warning">Add an image provider in Settings → AI providers & keys.</p>
              )
            ) : content.existingAssetId ? (
              <div className="flex items-center gap-3">
                <AssetThumb url={`relay-asset://asset/${content.existingAssetId}`} alt="Attached image" available className="size-14 rounded-md" />
                <span className="text-xs text-fg-subtle">Attached to every post</span>
                <Button size="sm" variant="ghost" icon={X} onClick={() => setContent({ existingAssetId: null })}>
                  Remove
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="ghost" icon={ImagePlus} className="self-start" onClick={() => setLibrary(true)}>
                Attach an image from the library
              </Button>
            )}
          </div>
        </div>
      </Section>

      <Section step={2} title="How posts go out">
        <SegmentedControl<AutomationConfig['mode']>
          value={config.mode}
          onChange={(mode) => set({ mode })}
          options={[
            { value: 'full-auto', label: 'Full Auto' },
            { value: 'manual-approval', label: 'Manual Approval' }
          ]}
        />
        <p className="text-xs text-fg-subtle">
          {config.mode === 'full-auto'
            ? 'Posts are generated, given their images, scheduled and published one after another — no confirmation per post.'
            : 'Posts are generated with their images and wait. You review, edit, regenerate, remove or approve each one before it is published.'}
        </p>
      </Section>

      <Section step={3} title="Profiles" description="IX Browser profiles synced into Axora Relay.">
        <ProfileTargets value={targets} onChange={(t) => set({ targets: t })} publishing={publishing} />
      </Section>

      <Section step={4} title="Actions" description="Only what you turn on runs.">
        <Toggle label="Publish original posts" checked={actions.publish} onChange={(publish) => setActions({ publish })} />
        <Toggle label="Save drafts" description="Keep the generated posts as drafts (when not publishing)." checked={actions.saveDrafts} onChange={(saveDrafts) => setActions({ saveDrafts })} />
        <div className="flex flex-col gap-3 border-t border-line pt-3">
          <p className="text-xs text-fg-subtle">
            Reposts, comments and likes are planned as tasks you complete in each profile — Axora Relay opens the post for you but doesn’t perform them. One of your accounts per post and action.
          </p>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <Toggle label="Repost" checked={actions.repost} onChange={(repost) => setActions({ repost })} />
            <Toggle label="Comment" checked={actions.comment} onChange={(comment) => setActions({ comment })} />
            <Toggle label="Like" checked={actions.like} onChange={(like) => setActions({ like })} />
          </div>
          {(actions.repost || actions.comment || actions.like) && (
            <Field label="Posts to engage with" htmlFor="auto-links" hint="One link per line (x.com or twitter.com).">
              <Textarea
                id="auto-links"
                rows={3}
                value={actions.engagementLinks.join('\n')}
                spellCheck={false}
                className="font-mono text-xs"
                onChange={(e) => setActions({ engagementLinks: e.target.value.split('\n') })}
              />
            </Field>
          )}
          {actions.comment && (
            <Field label="Your comment" htmlFor="auto-comment" hint="Copied into the task; you post it yourself.">
              <Textarea id="auto-comment" rows={2} value={actions.commentText} maxLength={4000} onChange={(e) => setActions({ commentText: e.target.value })} />
            </Field>
          )}
        </div>
      </Section>

      <Section step={5} title="Schedule and limits">
        <SegmentedControl<AutomationConfig['schedule']['when']>
          value={schedule.when}
          onChange={(when) =>
            setSchedule({
              when,
              startAt: when === 'schedule' ? (schedule.startAt ?? new Date(Date.now() + 3_600_000).toISOString()) : null
            })
          }
          options={[
            { value: 'now', label: 'Start now' },
            { value: 'schedule', label: 'Schedule' }
          ]}
        />
        <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
          {schedule.when === 'schedule' && (
            <Field label="Start" htmlFor="auto-start">
              <Input id="auto-start" type="datetime-local" value={toLocalInput(schedule.startAt)} onChange={(e) => setSchedule({ startAt: fromLocalInput(e.target.value) })} />
            </Field>
          )}
          <Field label="End (optional)" htmlFor="auto-end">
            <Input id="auto-end" type="datetime-local" value={toLocalInput(schedule.endAt)} onChange={(e) => setSchedule({ endAt: fromLocalInput(e.target.value) })} />
          </Field>
          <Field label="Minutes between posts" htmlFor="auto-interval" hint="Per profile">
            <Input
              id="auto-interval"
              inputMode="numeric"
              value={String(schedule.intervalMinutes)}
              onChange={(e) =>
                setSchedule({
                  intervalMinutes: num(e.target.value, 0, 1440, schedule.intervalMinutes)
                })
              }
            />
          </Field>
          <Field label="Posts per profile" htmlFor="auto-per-profile">
            <Input
              id="auto-per-profile"
              inputMode="numeric"
              value={String(schedule.postsPerProfile)}
              onChange={(e) =>
                setSchedule({
                  postsPerProfile: num(e.target.value, 1, 50, schedule.postsPerProfile)
                })
              }
            />
          </Field>
          <Field label="Max posts this run" htmlFor="auto-max">
            <Input
              id="auto-max"
              inputMode="numeric"
              value={String(schedule.maxPostsPerRun)}
              onChange={(e) =>
                setSchedule({
                  maxPostsPerRun: num(e.target.value, 1, 500, schedule.maxPostsPerRun)
                })
              }
            />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Toggle
            label="Working hours only"
            checked={schedule.workingHours.enabled}
            onChange={(enabled) =>
              setSchedule({
                workingHours: { ...schedule.workingHours, enabled }
              })
            }
          />
          {schedule.workingHours.enabled && (
            <span className="flex items-center gap-2 text-xs text-fg-subtle">
              <Input
                aria-label="From"
                type="time"
                value={schedule.workingHours.start}
                onChange={(e) =>
                  setSchedule({
                    workingHours: {
                      ...schedule.workingHours,
                      start: e.target.value
                    }
                  })
                }
                wrapperClassName="w-28"
              />
              to
              <Input
                aria-label="Until"
                type="time"
                value={schedule.workingHours.end}
                onChange={(e) =>
                  setSchedule({
                    workingHours: {
                      ...schedule.workingHours,
                      end: e.target.value
                    }
                  })
                }
                wrapperClassName="w-28"
              />
            </span>
          )}
        </div>
        <p className="text-xs text-fg-subtle">Posts go out while Axora Relay is running. Spacing between posts of one account and safe retries are set in Settings → Automation.</p>
      </Section>

      <Section step={6} title="When something goes wrong">
        <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
          <Field label="Text generation fails" htmlFor="fail-text">
            <Select<string>
              id="fail-text"
              value={failure.onTextFailure}
              onChange={(v) => setFailure({ onTextFailure: v as typeof failure.onTextFailure })}
              options={[
                { value: 'skip', label: 'Skip that post' },
                { value: 'pause', label: 'Pause the run' }
              ]}
            />
          </Field>
          <Field label="Image generation fails" htmlFor="fail-image">
            <Select<string>
              id="fail-image"
              value={failure.onImageFailure}
              onChange={(v) =>
                setFailure({
                  onImageFailure: v as typeof failure.onImageFailure
                })
              }
              options={[
                { value: 'pause', label: 'Pause the run' },
                { value: 'skip', label: 'Skip that post' },
                { value: 'without-image', label: 'Publish without an image' }
              ]}
            />
          </Field>
          <Field label="A profile is unavailable" htmlFor="fail-profile">
            <Select<string>
              id="fail-profile"
              value={failure.onProfileUnavailable}
              onChange={(v) =>
                setFailure({
                  onProfileUnavailable: v as typeof failure.onProfileUnavailable
                })
              }
              options={[
                { value: 'skip', label: 'Leave it out' },
                { value: 'stop', label: 'Don’t start' }
              ]}
            />
          </Field>
          <Field label="Extra generation attempts" htmlFor="fail-retries">
            <Select<string>
              id="fail-retries"
              value={String(failure.generationRetries)}
              onChange={(v) => setFailure({ generationRetries: Number(v) })}
              options={[0, 1, 2, 3].map((n) => ({
                value: String(n),
                label: n === 0 ? 'None' : String(n)
              }))}
            />
          </Field>
          <Field label="Pause after failed posts in a row" htmlFor="fail-stop">
            <Select<string>
              id="fail-stop"
              value={String(failure.stopAfterFailures)}
              onChange={(v) => setFailure({ stopAfterFailures: Number(v) })}
              options={[0, 2, 3, 5, 10].map((n) => ({
                value: String(n),
                label: n === 0 ? 'Never' : String(n)
              }))}
            />
          </Field>
        </div>
      </Section>

      <AssetLibraryDialog
        open={library}
        onClose={() => setLibrary(false)}
        maxPick={1}
        pickLabel="Attach"
        onPick={(assets) => {
          if (assets[0]) setContent({ existingAssetId: assets[0].id })
          setLibrary(false)
        }}
      />
    </div>
  )
}
