// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Dialog } from './dialog'

let host: HTMLDivElement, root: Root
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
async function key(key: string, shiftKey = false) {
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true })))
}
function Harness() {
  const [first, setFirst] = useState(false), [second, setSecond] = useState(false)
  return <>
    <button id="opener" onClick={() => setFirst(true)}>Open first</button>
    <button id="background">Background</button>
    <Dialog open={first} onOpenChange={setFirst} title="First" confirmLabel="Save">
      <button id="nested-opener" onClick={() => setSecond(true)}>Open second</button>
      <input id="disabled" disabled />
      <input id="hidden" hidden />
      <input id="css-hidden" style={{ display: 'none' }} />
      <button id="second-last" disabled>Disabled</button>
    </Dialog>
    <Dialog open={second} onOpenChange={setSecond} title="Second"><input aria-label="Second value" /></Dialog>
  </>
}
async function open() {
  await act(async () => root.render(<Harness />))
  const opener = document.querySelector<HTMLButtonElement>('#opener')!
  opener.focus(); await act(async () => opener.click())
  return opener
}
describe('modal keyboard lifecycle', () => {
  it('moves initial focus into the modal, closes with Escape and restores opener', async () => {
    const opener = await open()
    const panel = document.querySelector('[role="dialog"]')!
    expect(panel.contains(document.activeElement)).toBe(true)
    expect(!!opener.closest('[inert]')).toBe(true)
    await key('Escape')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(opener)
    expect(!!opener.closest('[inert]')).toBe(false)
  })
  it('cycles both boundaries and excludes disabled/hidden controls', async () => {
    await open()
    const close = document.querySelector<HTMLButtonElement>('[aria-label="Close"]')!
    const save = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save')!
    expect(document.activeElement).toBe(close)
    await key('Tab', true); expect(document.activeElement).toBe(save)
    await key('Tab'); expect(document.activeElement).toBe(close)
    document.querySelector<HTMLInputElement>('#css-hidden')!.focus()
    await key('Tab', true)
    expect(document.activeElement?.id).not.toMatch(/disabled|hidden/)
  })
  it('redirects accidental background focus back inside', async () => {
    await open()
    document.querySelector<HTMLButtonElement>('#background')!.focus()
    expect(document.querySelector('[role="dialog"]')!.contains(document.activeElement)).toBe(true)
  })
  it('only closes the top modal, preserving lower focus isolation and scroll lock', async () => {
    document.body.style.overflow = 'auto'
    const opener = await open()
    const nested = document.querySelector<HTMLButtonElement>('#nested-opener')!
    nested.focus(); await act(async () => nested.click())
    const panels = document.querySelectorAll('[role="dialog"]')
    expect(panels).toHaveLength(2)
    expect(panels[1].contains(document.activeElement)).toBe(true)
    expect(panels[0].parentElement!.hasAttribute('inert')).toBe(true)
    await key('Escape')
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(document.activeElement).toBe(nested)
    expect(document.body.style.overflow).toBe('hidden')
    expect(!!opener.closest('[inert]')).toBe(true)
    await key('Escape')
    expect(document.body.style.overflow).toBe('auto')
    expect(document.activeElement).toBe(opener)
    document.body.style.overflow = ''
  })
  it('preserves pre-existing inert attributes on cleanup', async () => {
    const existing = document.createElement('div'); existing.setAttribute('inert', ''); document.body.append(existing)
    try { await open(); await key('Escape'); expect(existing.hasAttribute('inert')).toBe(true) }
    finally { existing.remove() }
  })
})
