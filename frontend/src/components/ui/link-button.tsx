import { Link, type LinkProps } from 'react-router-dom'

import { buttonClasses, type ButtonSize, type ButtonVariant } from '@/components/ui/button-classes'

/**
 * A navigation link that looks like a button.
 *
 * This exists because the nine pages all wrote `<Link to="/check"><Button>Run a
 * check</Button></Link>`, which is a `<button>` nested inside an `<a>`. That is
 * invalid HTML and it is not a cosmetic problem:
 *
 * - The two elements are both in the accessibility tree, so a screen reader
 *   announces "link, button, Run a check" - two controls where there is one.
 * - The interactive content model says an `<a>` may not contain interactive
 *   descendants, so the behaviour of Enter, Space and middle-click is the
 *   browser's to decide rather than the platform's. Space scrolls the page on
 *   some of them instead of activating.
 * - A real link can be opened in a new tab, copied, and is announced as a link
 *   with a destination. A button that happens to navigate is announced as
 *   neither.
 *
 * The alternative was an `asChild` prop, which is how shadcn solves it and which
 * needs `@radix-ui/react-slot`. F.1c adds no dependencies, so the composition is
 * done here instead: same `buttonClasses`, different element.
 *
 * Note what this component deliberately does *not* have: `loading` and
 * `disabled`. A link is not a form control, `disabled` does not apply to an
 * anchor, and pretending otherwise produces a link that looks disabled and still
 * navigates.
 */

export interface LinkButtonProps extends Omit<LinkProps, 'className'> {
  variant?: ButtonVariant
  size?: ButtonSize
  className?: string
}

export function LinkButton({
  variant = 'primary',
  size = 'md',
  className,
  children,
  ...props
}: LinkButtonProps) {
  return (
    <Link {...props} className={buttonClasses(variant, size, className)}>
      {children}
    </Link>
  )
}
