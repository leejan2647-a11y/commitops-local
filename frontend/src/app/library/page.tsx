import { PageHeader } from '@/components/page-states'
import { FileLibrary } from '@/app/data-sources/file-library'
import { LibraryCheckHistory } from './check-history'

export function LibraryPage() {
  return <div className="space-y-6"><PageHeader title="Library" description="Your retained billing files and shared check history" /><FileLibrary /><LibraryCheckHistory /></div>
}
