import * as React from 'react'

import { cn } from '@/lib/utils'
import { useControllableState } from '@/components/ui/use-controllable-state'

/**
 * Tabs.
 *
 * Hand-rolled, Task F.1c Step 2. Controlled-first, so its selected state is
 * assertable from a server-rendered snapshot.
 *
 * The accessibility here is the whole reason it is not just three styled
 * `<button>`s. WAI-ARIA's tabs pattern requires a specific set of relationships,
 * and a tabs group built without them is worse than no tabs at all - a screen
 * reader announces three unrelated buttons and the user has no idea the panels
 * are alternatives to each other:
 *
 * - `role="tablist"` on the container, `role="tab"` on each trigger,
 *   `role="tabpanel"` on each panel;
 * - `aria-controls` on a tab pointing at its panel id, and `aria-labelledby`
 *    on the panel pointing back;
 * - exactly one tab with `aria-selected="true"` and exactly one panel that is
 *    not `hidden`;
 * - roving `tabIndex` - the selected tab is reachable with Tab, the others are
 *    not, so Tab moves *out* of the tab list rather than through all five.
 *
 * The last one is the detail most hand-rolled tab sets get wrong, and it is what
 * makes a 5-tab filter feel broken to navigate.
 *
 * The panel wrappers stay mounted and hidden; their *content* is unmounted when
 * a tab is not active. That is a deliberate trade. The alternative - rendering
 * all five panels and hiding four - preserves local component state, but on
 * `/findings` it means five copies of the same findings table mounted at once,
 * and on any future tab holding a chart it means five charts. The case that
 * would actually lose something, a half-filled form inside a tab, is not one
 * this app has. Data fetched through React Query is unaffected either way: it
 * lives in the provider's cache, so a remounted panel is served from cache
 * rather than refetched.
 */

export interface TabItem {
  /** Stable id fragment. Becomes `{id}-tab-{value}`. */
  value: string
  label: string
  disabled?: boolean
  /** Shown after the label - a count, usually. */
  badge?: React.ReactNode
}

export interface TabsProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange' | 'children'> {
  items: TabItem[]
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  id?: string
  /**
   * The active panel's content, or a function of the active value.
   *
   * Both because the two uses are different and neither is rarer. `/findings`
   * filters one list five ways and passes a node; a page with genuinely
   * different panels per tab passes a function. Supporting only the node form
   * means the second case cannot be built at all, and supporting only the
   * function form means the common one needs a wrapper that ignores its
   * argument.
   */
  children?: React.ReactNode | ((value: string) => React.ReactNode)
}

/** Resolves the two forms of `children` in one place. */
function panelContent(children: TabsProps['children'], value: string): React.ReactNode {
  return typeof children === 'function' ? children(value) : (children ?? null)
}

export function Tabs({
  items,
  value,
  defaultValue,
  onValueChange,
  id = 'tabs',
  className,
  children,
  ...props
}: TabsProps) {
  const [active, setActive] = useControllableState<string>({
    value,
    defaultValue: defaultValue ?? items.find((i) => !i.disabled)?.value ?? items[0]?.value,
    onChange: onValueChange,
  })

  // A tab can be removed while one of them is selected - `/findings` filters by
  // severity, and a filter that empties a tab must not leave the list pointing
  // at a tab that is no longer there.
  const activeExists = items.some((i) => i.value === active && !i.disabled)
  const selected = activeExists ? active : (items.find((i) => !i.disabled)?.value ?? items[0]?.value)

  const panelFor = (v: string) => `${id}-panel-${v}`
  const tabFor = (v: string) => `${id}-tab-${v}`

  return (
    <div className={cn('flex flex-col', className)} {...props}>
      <div
        role="tablist"
        aria-label={props['aria-label'] ?? 'Sections'}
        className="flex gap-1 overflow-x-auto border-b border-border"
      >
        {items.map((item) => {
          const isSelected = item.value === selected
          return (
            <button
              key={item.value}
              id={tabFor(item.value)}
              role="tab"
              type="button"
              aria-selected={isSelected}
              aria-controls={panelFor(item.value)}
              disabled={item.disabled}
              // Roving tabindex: only the selected tab is in the tab order.
              tabIndex={isSelected ? 0 : -1}
              onClick={() => setActive(item.value)}
              onKeyDown={(event) => {
                const enabled = items.filter(candidate => !candidate.disabled)
                const index = enabled.findIndex(candidate => candidate.value === item.value)
                let next: number
                if (event.key === 'ArrowRight') next = (index + 1) % enabled.length
                else if (event.key === 'ArrowLeft') next = (index - 1 + enabled.length) % enabled.length
                else if (event.key === 'Home') next = 0
                else if (event.key === 'End') next = enabled.length - 1
                else return
                const target = enabled[next]
                if (!target) return
                event.preventDefault()
                setActive(target.value)
                Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])
                  .find(button => button.id === tabFor(target.value))?.focus()
              }}
              className={cn(
                'whitespace-nowrap border-b-2 px-4 py-2.5 text-body font-medium',
                'transition-colors duration-landing ease-landing',
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                isSelected
                  ? 'border-accent text-accent'
                  : 'border-transparent text-muted-foreground hover:border-accent-border hover:text-foreground',
                item.disabled && 'cursor-not-allowed opacity-50',
              )}
            >
              {item.label}
              {item.badge != null ? (
                <span className="ml-2 font-mono text-mono text-subtle">{item.badge}</span>
              ) : null}
            </button>
          )
        })}
      </div>

      {items.map((item) => (
        <div
          key={item.value}
          id={panelFor(item.value)}
          role="tabpanel"
          aria-labelledby={tabFor(item.value)}
          // The wrapper is always present so the panel ids and their
          // `aria-labelledby` relationships are stable, but a panel that is not
          // active is hidden - out of the tab order and out of the
          // accessibility tree - and its content is not rendered.
          hidden={item.value !== selected}
          // Only the active panel is focusable. A `tabIndex` on a hidden panel is
          // inert in the browser, but it is not inert in the markup: a roving
          // tabindex that reports six tab stops instead of two is wrong in the
          // HTML even where the browser forgives it.
          tabIndex={item.value === selected ? 0 : -1}
          className="py-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {item.value === selected ? panelContent(children, item.value) : null}
        </div>
      ))}
    </div>
  )
}
