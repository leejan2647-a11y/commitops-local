// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { Dialog } from './dialog'

it('escapes a blurred card so viewport bounds and wheel scrolling belong to the modal', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const card = document.createElement('section')
  card.style.backdropFilter = 'blur(16px)'
  document.body.append(card)
  const root = createRoot(card)
  try {
    await act(async () => root.render(<Dialog open title="Long content" confirmLabel="Save"><p>Content</p></Dialog>))
    const panel = document.querySelector('[role="dialog"]')!
    expect(card.contains(panel)).toBe(false)
    expect(panel.parentElement?.parentElement).toBe(document.body)
    expect(panel.parentElement?.classList.contains('flow-route')).toBe(true)
    expect(document.body.style.overflow).toBe('hidden')
  } finally {
    await act(async () => root.unmount())
    card.remove()
  }
  expect(document.body.style.overflow).not.toBe('hidden')
})
