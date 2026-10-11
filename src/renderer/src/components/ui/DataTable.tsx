import { ArrowDown, ArrowUp } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Checkbox } from './Checkbox'
import { Skeleton } from './Skeleton'

export interface Column<T> {
  id: string
  header: string
  cell: (row: T) => ReactNode
  /** CSS width, e.g. "28%" or "120px". */
  width?: string
  align?: 'left' | 'right'
  /** Providing this makes the column sortable. */
  sortValue?: (row: T) => string | number
  className?: string
}

export interface TableSelection<T> {
  selected: ReadonlySet<string>
  onChange: (next: Set<string>) => void
  /** Accessible name for a row's checkbox. */
  rowLabel: (row: T) => string
}

interface DataTableProps<T> {
  rows: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string
  loading?: boolean
  empty?: ReactNode
  onRowClick?: (row: T) => void
  density?: 'compact' | 'comfortable'
  initialSort?: { id: string; direction: 'asc' | 'desc' }
  /** Render rows incrementally for long lists (sorting still covers every row). */
  pageSize?: number
  /** Adds a checkbox column. The header box selects every row passed in (not just the rendered page). */
  selection?: TableSelection<T>
  /** Key of the row shown in a details panel; it is highlighted. */
  activeKey?: string | null
  className?: string
  'aria-label'?: string
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  loading = false,
  empty,
  onRowClick,
  density = 'comfortable',
  initialSort,
  pageSize,
  selection,
  activeKey,
  className,
  ...aria
}: DataTableProps<T>) {
  const [sort, setSort] = useState(initialSort ?? null)
  const [visible, setVisible] = useState(pageSize ?? Number.POSITIVE_INFINITY)

  const sorted = useMemo(() => {
    const column = sort && columns.find((c) => c.id === sort.id)
    if (!sort || !column?.sortValue) return rows
    const getValue = column.sortValue
    const factor = sort.direction === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = getValue(a)
      const bv = getValue(b)
      return (typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv))) * factor
    })
  }, [rows, columns, sort])

  const toggleSort = (id: string) =>
    setSort((current) =>
      current?.id === id ? { id, direction: current.direction === 'asc' ? 'desc' : 'asc' } : { id, direction: 'asc' }
    )

  const rowHeight = density === 'compact' ? 'h-10' : 'h-12'
  const shown = sorted.length > visible ? sorted.slice(0, visible) : sorted
  const remaining = sorted.length - shown.length

  const keys = selection ? rows.map(rowKey) : []
  const selectedCount = selection ? keys.filter((key) => selection.selected.has(key)).length : 0
  const toggleAll = (checked: boolean) => {
    if (!selection) return
    const next = new Set(selection.selected)
    for (const key of keys) {
      if (checked) next.add(key)
      else next.delete(key)
    }
    selection.onChange(next)
  }
  const toggleOne = (key: string, checked: boolean) => {
    if (!selection) return
    const next = new Set(selection.selected)
    if (checked) next.add(key)
    else next.delete(key)
    selection.onChange(next)
  }

  return (
    <div className={cn('min-w-0 overflow-x-auto', className)}>
      <table aria-label={aria['aria-label']} aria-busy={loading || undefined} className="w-full table-fixed border-collapse text-sm">
        <colgroup>
          {selection && <col style={{ width: '44px' }} />}
          {columns.map((column) => (
            <col key={column.id} style={column.width ? { width: column.width } : undefined} />
          ))}
        </colgroup>
        <thead>
          <tr className="h-8 border-b border-line">
            {selection && (
              <th scope="col" className="pl-4 pr-0 text-left">
                <Checkbox
                  aria-label={selectedCount === keys.length && keys.length > 0 ? 'Deselect all rows' : 'Select all rows'}
                  checked={keys.length > 0 && selectedCount === keys.length}
                  indeterminate={selectedCount > 0 && selectedCount < keys.length}
                  disabled={loading || keys.length === 0}
                  onChange={toggleAll}
                />
              </th>
            )}
            {columns.map((column) => {
              const active = sort?.id === column.id
              const SortIcon = active && sort.direction === 'desc' ? ArrowDown : ArrowUp
              return (
                <th
                  key={column.id}
                  scope="col"
                  aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}
                  className={cn(
                    'whitespace-nowrap px-4 text-2xs font-medium uppercase tracking-[0.06em] text-fg-subtle',
                    column.align === 'right' ? 'text-right' : 'text-left'
                  )}
                >
                  {column.sortValue ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(column.id)}
                      className={cn(
                        'group inline-flex items-center gap-1 rounded-xs uppercase hover:text-fg-muted focus-ring',
                        active && 'text-fg-muted'
                      )}
                    >
                      {column.header}
                      <SortIcon
                        size={11}
                        strokeWidth={2}
                        className={cn('transition-opacity', active ? 'opacity-100' : 'opacity-0 group-hover:opacity-50')}
                      />
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: 4 }, (_, index) => (
                <tr key={index} className={cn(rowHeight, 'border-b border-line last:border-0')}>
                  {selection && <td className="pl-4" />}
                  {columns.map((column, ci) => (
                    <td key={column.id} className="px-4">
                      <Skeleton className={cn('h-2.5', ci === 0 ? 'w-3/4' : 'w-1/2', column.align === 'right' && 'ml-auto')} />
                    </td>
                  ))}
                </tr>
              ))
            : shown.map((row) => {
                const key = rowKey(row)
                const checked = selection?.selected.has(key) ?? false
                return (
                <tr
                  key={key}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={
                    onRowClick
                      ? (event) => {
                          if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
                          event.preventDefault()
                          onRowClick(row)
                        }
                      : undefined
                  }
                  tabIndex={onRowClick ? 0 : undefined}
                  aria-current={activeKey === key ? 'true' : undefined}
                  data-selected={checked || undefined}
                  className={cn(
                    rowHeight,
                    'border-b border-line transition-colors last:border-0 hover:bg-highlight',
                    onRowClick && 'cursor-pointer outline-none focus-visible:bg-highlight focus-visible:shadow-[inset_2px_0_0_var(--accent)]',
                    checked && 'bg-accent-soft/40 hover:bg-accent-soft/60',
                    activeKey === key && 'bg-highlight shadow-[inset_2px_0_0_var(--accent)]'
                  )}
                >
                  {selection && (
                    <td
                      className="cursor-default pl-4 pr-0"
                      onClick={(event) => {
                        event.stopPropagation()
                        toggleOne(key, !checked)
                      }}
                    >
                      <Checkbox aria-label={`Select ${selection.rowLabel(row)}`} checked={checked} onChange={(next) => toggleOne(key, next)} />
                    </td>
                  )}
                  {columns.map((column) => (
                    <td
                      key={column.id}
                      className={cn(
                        'truncate px-4 text-fg-muted',
                        column.align === 'right' && 'text-right',
                        column.className
                      )}
                    >
                      {column.cell(row)}
                    </td>
                  ))}
                </tr>
                )
              })}
        </tbody>
      </table>
      {!loading && rows.length === 0 && empty}
      {!loading && remaining > 0 && pageSize && (
        <div className="flex items-center justify-center gap-3 border-t border-line py-2.5 text-xs text-fg-subtle">
          Showing {shown.length} of {sorted.length}
          <button
            type="button"
            onClick={() => setVisible((v) => v + pageSize)}
            className="rounded-xs font-medium text-accent-text hover:underline focus-ring"
          >
            Show {Math.min(pageSize, remaining)} more
          </button>
        </div>
      )}
    </div>
  )
}
