import {LocalDocs} from '@/app/local-docs'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ObservatoryLayout } from '@/components/observatory-layout'
import { FlowFrame } from '@/flow/flow-frame'
import { Dashboard } from '@/app/dashboard/page'
import { CheckCharges } from '@/app/check/page'
import { Findings } from '@/app/findings/page'
import { FindingDetail } from '@/app/findings/[id]/page'
import { Commitments } from '@/app/commitments/page'
import { Allocation } from '@/app/allocation/page'
import { Reports } from '@/app/reports/page'
import { LibraryPage } from '@/app/library/page'
import { Settings } from '@/app/settings/page'
const client=new QueryClient({defaultOptions:{queries:{retry:1,staleTime:30000}}})
export default function App(){return <QueryClientProvider client={client}><BrowserRouter><FlowFrame><ObservatoryLayout><Routes>
<Route path="/docs" element={<LocalDocs/>}/><Route path="/dashboard" element={<Dashboard/>}/><Route path="/check" element={<CheckCharges/>}/><Route path="/findings" element={<Findings/>}/><Route path="/findings/:id" element={<FindingDetail/>}/><Route path="/commitments" element={<Commitments/>}/><Route path="/allocation" element={<Allocation/>}/><Route path="/reports" element={<Reports/>}/><Route path="/library" element={<LibraryPage/>}/><Route path="/settings" element={<Settings/>}/><Route path="*" element={<Navigate to="/dashboard" replace/>}/>
</Routes></ObservatoryLayout></FlowFrame></BrowserRouter></QueryClientProvider>}
