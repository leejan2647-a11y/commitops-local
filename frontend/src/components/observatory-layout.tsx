import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { LayoutDashboard, Search, AlertCircle, CreditCard, PieChart, FileText, Database, Settings, Library, LogOut, Menu, ArrowUpRight } from 'lucide-react'

import { SiteLogo } from '@/components/site-logo'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useAuth } from '@/lib/use-auth'
import { MotionToggle } from '@/flow/scene/MotionToggle'

const navigationItems = [
  { name: 'Dashboard', path: '/dashboard', icon: LayoutDashboard },
  { name: 'Check Charges', path: '/check', icon: Search },
  { name: 'Findings', path: '/findings', icon: AlertCircle },
  { name: 'Commitments', path: '/commitments', icon: CreditCard },
  { name: 'Allocation', path: '/allocation', icon: PieChart },
  { name: 'Reports', path: '/reports', icon: FileText },
  { name: 'Library', path: '/library', icon: Library },
  { name: 'Settings', path: '/settings', icon: Settings },
]

/** Flow workspace presentation over the real Router, identity and page controllers. */
export function ObservatoryLayout({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const { user, signOut } = useAuth()
  const [navigationOpen, setNavigationOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState(false)
  const active = navigationItems
    .filter(item => location.pathname === item.path || location.pathname.startsWith(`${item.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0]

  const navigation = (drawer = false) => (
    <nav aria-label="Main" className={cn('observatory-nav', drawer && 'is-open')}>
      {navigationItems.map(({ name, path, icon: Icon }) => (
        <Link key={path} to={path} onClick={() => setNavigationOpen(false)} aria-current={active?.path === path ? 'page' : undefined} className={cn('observatory-nav-link', active?.path === path && 'is-active')}>
          <Icon size={16} strokeWidth={1.5} aria-hidden="true" /><span>{name}</span>
        </Link>
      ))}
    </nav>
  )

  async function handleSignOut() {
    if (signingOut) return
    setSigningOut(true)
    setSignOutError(false)
    try { await signOut() } catch { setSignOutError(true) } finally { setSigningOut(false) }
  }

  return (
    <div className="observatory-app flow-workspace">
      <a href="#workspace-content" className="observatory-skip">Skip to content</a>
      <header className="observatory-topbar">
        <div className="flow-brand-row">
          <Button variant="ghost" size="icon" className="flow-mobile-toggle flow-secondary" aria-label="Open navigation" aria-expanded={navigationOpen} onClick={() => setNavigationOpen(true)}><Menu size={18} /></Button>
          <Link className="public-brand brand" to="/"><SiteLogo /><span>CommitOps</span></Link>
          <span className="flow-workspace-label">Your workspace</span>
        </div>
        <div className="flow-button-row">
          <Link to="/docs" className="inline-flex min-h-11 items-center text-caption text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline focus-visible:outline-2" aria-label="Documentation">Documentation</Link>
          <MotionToggle />
          <span className="observatory-identity" title={user?.email}>{user?.email ?? ''}</span>
        </div>
      </header>
      {signOutError ? <p role="alert" className="mx-auto mb-4 w-[calc(100%-56px)] max-w-[1440px] rounded-xl border border-danger/40 p-3 text-body text-danger">Could not sign out. Please try again.</p> : null}
      {navigation()}
      <main id="workspace-content" tabIndex={-1} className="observatory-content">
        <div className="observatory-page">{children}</div>
        <footer className="observatory-workspace-footer"><span>Local files only · No external connections.</span></footer>
      </main>
      <Dialog open={navigationOpen} onOpenChange={setNavigationOpen} title="Workspace navigation" cancelLabel="Close navigation" className="observatory-drawer fixed inset-y-0 left-0 max-h-none w-[min(21rem,calc(100vw-2rem))] rounded-none">
        {navigation(true)}
      </Dialog>
    </div>
  )
}
