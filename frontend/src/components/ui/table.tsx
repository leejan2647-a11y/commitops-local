import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Table.
 *
 * Hand-rolled, Task F.1c Step 2.
 *
 * The nine pages show account ids, plan ids, percentages and dollar amounts.
 * Three things follow from that, and all three are the reason this is more than
 * the previous version:
 *
 * **Two densities.** A findings list and an allocation breakdown are both
 * tables, and one row height cannot suit both: `comfortable` is 48px rows for a
 * page you read, `compact` is 36px for one you scan. Density is set once on
 * `Table` and reaches the cells through context, because passing it to every
 * `TableCell` by hand is how one cell ends up at a different height from the
 * row it is in.
 *
 * **A sticky header.** The allocation matrix is taller than a laptop viewport,
 * and a header that scrolls away means every number below it is unattributable.
 * The sticky context is the `overflow-auto` wrapper, which is why that wrapper
 * is not optional and why `Table` sets a `max-height` when asked to.
 *
 * **`numeric` cells are right-aligned and tabular.** Proportional figures mean
 * a column of amounts that does not line up on the decimal point, so a reader
 * comparing $1,200.00 against $980.50 has to compare glyph shapes. This is a
 * correctness aid, not a preference.
 *
 * The wrapper keeps `overflow-auto` rather than `overflow-hidden` so a table
 * wider than a 375px screen scrolls inside the card instead of forcing the whole
 * page sideways.
 */

export type TableDensity = 'compact' | 'comfortable'

/** Row and cell heights per density. */
const DENSITY = {
  compact: { head: 'h-9 px-3', cell: 'h-9 px-3' },
  comfortable: { head: 'h-12 px-4', cell: 'px-4 py-3' },
} as const

const DensityContext = React.createContext<TableDensity>('comfortable')

export interface TableProps extends React.HTMLAttributes<HTMLDivElement> {
  density?: TableDensity
  /**
   * Caps the scrollable height, which is what makes the sticky header do
   * anything. Without it the wrapper grows to fit and the header never sticks
   * because there is nothing to scroll past.
   */
  maxHeight?: string
}

export const Table = React.forwardRef<HTMLDivElement, TableProps>(function Table(
  { className, density = 'comfortable', maxHeight, children, ...props },
  ref,
) {
  return (
    <DensityContext.Provider value={density}>
      <div
        ref={ref}
        className={cn('relative w-full overflow-auto', className)}
        style={maxHeight ? { maxHeight } : undefined}
        {...props}
      >
        <table className="w-full border-collapse text-body">{children}</table>
      </div>
    </DensityContext.Provider>
  )
})

export const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(function TableHeader({ className, ...props }, ref) {
  return <thead ref={ref} className={cn('bg-surface', className)} {...props} />
})

export const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(function TableBody({ className, ...props }, ref) {
  return <tbody ref={ref} className={cn('', className)} {...props} />
})

export interface TableRowProps extends React.HTMLAttributes<HTMLTableRowElement> {
  selected?: boolean
}

export const TableRow = React.forwardRef<HTMLTableRowElement, TableRowProps>(function TableRow(
  { className, selected = false, ...props },
  ref,
) {
  return (
    <tr
      ref={ref}
      // `group` is not needed here; the hover is on the row itself so the
      // background covers the whole row including cells that set their own.
      className={cn(
        'border-b border-border/60 transition-colors duration-fast',
        'hover:bg-surface-hover',
        selected && 'bg-surface-raised',
        className,
      )}
      {...props}
    />
  )
})

export interface TableHeadProps extends React.ThHTMLAttributes<HTMLTableCellElement> {
  numeric?: boolean
  /** Visually hidden sort direction, for a sortable column header. */
  sorted?: 'asc' | 'desc' | false
}

export const TableHead = React.forwardRef<HTMLTableCellElement, TableHeadProps>(function TableHead(
  { className, numeric = false, sorted = false, children, ...props },
  ref,
) {
  const density = React.useContext(DensityContext)
  return (
    <th
      ref={ref}
      scope="col"
      // Sticky needs the header cell itself, not the row, so each cell sticks
      // independently and the background covers any cell that scrolls under it.
      className={cn(
        'sticky top-0 z-10 border-b border-border bg-surface text-left',
        'font-mono text-mono font-medium uppercase tracking-label text-muted-foreground',
        DENSITY[density].head,
        numeric && 'text-right',
        sorted && 'text-accent',
        className,
      )}
      {...props}
    >
      {children}
    </th>
  )
})

export interface TableCellProps extends React.TdHTMLAttributes<HTMLTableCellElement> {
  /** Right-align and use tabular figures. Use for money, counts and percentages. */
  numeric?: boolean
  /** De-emphasise: a total row, a column that is context rather than content. */
  muted?: boolean
}

export const TableCell = React.forwardRef<HTMLTableCellElement, TableCellProps>(function TableCell(
  { className, numeric = false, muted = false, children, ...props },
  ref,
) {
  const density = React.useContext(DensityContext)
  return (
    <td
      ref={ref}
      className={cn(
        'align-middle text-foreground',
        DENSITY[density].cell,
        // `tabular-nums` is the point of `numeric`: proportional figures do not
        // line up on the decimal, so a column of amounts cannot be scanned.
        numeric && 'text-right font-mono text-mono tabular-nums',
        muted && 'text-muted-foreground',
        className,
      )}
      {...props}
    >
      {children}
    </td>
  )
})

/** A caption for the table. Visually hidden unless given a class. */
export const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(function TableCaption({ className, ...props }, ref) {
  return (
    <caption
      ref={ref}
      className={cn('mt-3 text-caption text-subtle', className)}
      {...props}
    />
  )
})
