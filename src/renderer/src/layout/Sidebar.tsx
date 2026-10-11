import { NavLink } from 'react-router'
import { Tooltip } from '@/components/ui'
import { cn } from '@/lib/cn'
import { NAV_GROUPS, NAV_ITEMS, type NavItem } from '@/app/navigation'
import { UserMenu } from './UserMenu'

function SidebarLink({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const Icon = item.icon
  const link = (
    <NavLink
      to={item.path}
      aria-label={collapsed ? item.label : undefined}
      className={({ isActive }) =>
        cn(
          'group relative flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors duration-150 focus-ring',
          isActive ? 'bg-surface-3 text-fg shadow-raised' : 'text-fg-muted hover:bg-neutral-soft hover:text-fg',
          collapsed && 'justify-center px-0'
        )
      }
    >
      {({ isActive }) => (
        <>
          <span
            aria-hidden
            className={cn(
              'absolute -left-3 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-accent transition-all duration-200',
              isActive ? 'opacity-100' : 'h-0 opacity-0',
              collapsed && '-left-2'
            )}
          />
          <Icon
            size={16}
            strokeWidth={isActive ? 2 : 1.75}
            className={cn('shrink-0 transition-colors', isActive ? 'text-accent-text' : 'text-fg-subtle group-hover:text-fg-muted')}
            aria-hidden
          />
          {!collapsed && <span className="truncate">{item.label}</span>}
        </>
      )}
    </NavLink>
  )

  return collapsed ? (
    <Tooltip content={item.label} side="right" className="w-full">
      {link}
    </Tooltip>
  ) : (
    link
  )
}

export function Sidebar({ collapsed }: { collapsed: boolean }) {
  return (
    <nav
      aria-label="Primary"
      className={cn(
        'flex shrink-0 flex-col bg-canvas transition-[width] duration-200 ease-out',
        collapsed ? 'w-[56px]' : 'w-[232px]'
      )}
    >
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overflow-x-hidden pb-3 pt-2',
          collapsed ? 'px-2' : 'px-3'
        )}
      >
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="flex flex-col gap-0.5">
            {collapsed ? (
              <span className="mx-auto mb-1.5 h-px w-4 bg-line-strong first:hidden" aria-hidden />
            ) : (
              <span className="px-2.5 pb-1.5 text-2xs font-medium uppercase tracking-[0.08em] text-fg-faint">{group.label}</span>
            )}
            {group.items.map((item) => (
              <SidebarLink key={item.id} item={item} collapsed={collapsed} />
            ))}
          </div>
        ))}
      </div>
      <div className={cn('flex flex-col gap-1 border-t border-line py-2.5', collapsed ? 'px-2' : 'px-3')}>
        <SidebarLink item={NAV_ITEMS.settings} collapsed={collapsed} />
        <UserMenu collapsed={collapsed} />
      </div>
    </nav>
  )
}
