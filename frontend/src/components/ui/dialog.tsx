import * as React from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useControllableState } from '@/components/ui/use-controllable-state'

type ModalEntry = { root: HTMLElement; panel: HTMLElement }
const modalStack: ModalEntry[] = []
const isolated = new Map<HTMLElement, string | null>()
let bodyOverflow = ''

function restoreIsolation() {
  for (const [element, value] of isolated) {
    if (value === null) element.removeAttribute('inert')
    else element.setAttribute('inert', value)
  }
  isolated.clear()
}

function isolateTopModal() {
  restoreIsolation()
  let branch: HTMLElement | null = modalStack[modalStack.length - 1]?.root ?? null
  // Keep the ancestor path usable; isolate its siblings, including lower modals.
  while (branch && branch !== document.body) {
    const parent: HTMLElement | null = branch.parentElement
    if (!parent) break
    for (const sibling of parent.children) {
      if (sibling !== branch && sibling instanceof HTMLElement) {
        isolated.set(sibling, sibling.getAttribute('inert'))
        sibling.setAttribute('inert', '')
      }
    }
    branch = parent
  }
}

function tabStops(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(
    'a[href], button, textarea, input, select, [tabindex]',
  )).filter(element => {
    if (element.tabIndex < 0 || element.matches(':disabled, input[type="hidden"]')) return false
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (node.hidden || node.hasAttribute('inert') || style.display === 'none'
        || style.visibility === 'hidden' || style.visibility === 'collapse') return false
      if (node === panel) break
    }
    return true
  })
}

function focusPanel(panel: HTMLElement) {
  const stops = tabStops(panel)
  const target = stops.find(element => element.hasAttribute('autofocus')) ?? stops[0] ?? panel
  target.focus()
}

/**
 * Dialog.
 *
 * Hand-rolled, Task F.1c Step 2. No Radix, no Headless UI.
 *
 * A modal dialog has three obligations that are easy to skip and expensive to
 * get wrong, so each is implemented explicitly rather than delegated:
 *
 * 1. **The page behind must not scroll.** Without this, a dialog on a phone
 *    scrolls the content behind it when the user swipes inside the panel, and
 *    the panel appears to move away from its own header. `overflow: hidden` on
 *    the body while open, restored on close - including on unmount, which is
 *    the case that leaves a page permanently unscrollable after a navigation.
 *
 * 2. **Escape closes it and focus returns where it came from.** A dialog that
 *    swallows Escape is a keyboard trap, and one that closes without restoring
 *    focus drops the user at the top of the document. Both are handled from the
 *    same effect, and both are cleared on unmount.
 *
 * 3. **`aria-modal` plus a labelled dialog.** `aria-modal="true"` is what tells
 *    a screen reader the rest of the page is unavailable; without a `title` or
 *    `aria-label` the dialog is announced as just "dialog", which is worse than
 *    useless when a user has four of them in their history.
 *
 * The document handlers serve only the top modal. Its focusable controls are
 * rechecked on each Tab press because children can become hidden or disabled.
 */

export interface DialogProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  /** Announced as the dialog's name. */
  title: string
  /** Optional supporting line under the title. */
  description?: string
  /** The confirm action. Omit for a dialog with no primary action. */
  confirmLabel?: string
  onConfirm?: () => void
  /** Renders the confirm button as `danger`. */
  destructive?: boolean
  cancelLabel?: string
  children?: React.ReactNode
}

export function Dialog({
  open,
  defaultOpen = false,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  destructive = false,
  cancelLabel = 'Cancel',
  children,
  className,
  ...props
}: DialogProps) {
  const [isOpen, setOpen] = useControllableState<boolean>({
    value: open,
    defaultValue: defaultOpen,
    onChange: onOpenChange,
  })

  const panelRef = React.useRef<HTMLDivElement | null>(null)
  const backdropRef = React.useRef<HTMLDivElement | null>(null)
  // Keep server rendering available; in the browser escape card filters and
  // route transforms, which otherwise make fixed overlays card-relative.
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => { setMounted(true) }, [])

  const close = React.useCallback(() => setOpen(false), [setOpen])

  React.useEffect(() => {
    if (!mounted || !isOpen || !panelRef.current || !backdropRef.current) return
    const panel = panelRef.current
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const entry = { root: backdropRef.current, panel }
    if (modalStack.length === 0) {
      bodyOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
    }
    modalStack.push(entry)
    isolateTopModal()
    const isTop = () => modalStack[modalStack.length - 1] === entry
    const onFocus = (event: FocusEvent) => {
      if (isTop() && !panel.contains(event.target as Node)) focusPanel(panel)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTop()) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close()
      } else if (event.key === 'Tab') {
        const stops = tabStops(panel)
        const first = stops[0] ?? panel
        const last = stops[stops.length - 1] ?? panel
        if (!stops.includes(document.activeElement as HTMLElement)
          || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
          event.preventDefault()
          ;(event.shiftKey ? last : first).focus()
        }
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('focusin', onFocus, true)
    focusPanel(panel)
    return () => {
      const wasTop = isTop()
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('focusin', onFocus, true)
      modalStack.splice(modalStack.indexOf(entry), 1)
      isolateTopModal()
      const top = modalStack[modalStack.length - 1]
      if (!top) document.body.style.overflow = bodyOverflow
      if (wasTop) {
        if (opener?.isConnected && (!top || top.panel.contains(opener))) opener.focus()
        else if (top) focusPanel(top.panel)
      }
    }
  }, [mounted, isOpen, close])

  if (!isOpen) return null

  const content = (
    <div
      ref={backdropRef}
      // The backdrop. Clicking it closes, which is the convention and also the
      // only way out on a device with no Escape key.
      className="flow-route fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-black/70 p-4 sm:items-center"
      onClick={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          'flow-dialog flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-surface-raised shadow-panel',
          className,
        )}
        {...props}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border p-5">
          <div className="flex flex-col gap-1">
            <h2 className="text-h3 font-extrabold tracking-tight text-foreground">{title}</h2>
            {description ? (
              <p className="text-body text-muted-foreground">{description}</p>
            ) : null}
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close"
            className="-mr-1 -mt-1 shrink-0"
            onClick={close}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>

        {children ? <div className="min-h-0 overflow-y-auto overscroll-contain p-5 text-body text-foreground">{children}</div> : null}

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border p-4">
          <Button variant="ghost" onClick={close}>
            {cancelLabel}
          </Button>
          {confirmLabel ? (
            <Button variant={destructive ? 'danger' : 'primary'} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
  return mounted ? createPortal(content, document.body) : content
}
