import { lazy, Suspense } from 'react'
import { isLocalMode } from '../lib/mode'
const LocalAssistant = lazy(() => import('../local/LocalAssistant'))
const RemoteChatPanel = lazy(() => import('./RemoteChatPanel'))
export default function ChatPanel({ siteId }: { siteId: string }) {
  return <Suspense fallback={<div className="p-4 text-sm text-slate-400">Opening assistant…</div>}>{isLocalMode ? <LocalAssistant siteId={siteId} /> : <RemoteChatPanel siteId={siteId} />}</Suspense>
}
