import { Component, type ReactNode } from 'react'

export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error) { console.error('App view failed', error) }
  render() {
    if (this.state.failed) return <div role="alert" className="grid h-full place-items-center bg-slate-950 p-6 text-slate-200"><div className="max-w-sm text-center"><h1 className="text-lg font-semibold">This view could not open</h1><p className="mt-2 text-sm text-slate-400">Your saved local data has not been reset. Reload the app to try again.</p><button className="mt-4 rounded-xl bg-sky-400 px-5 py-3 font-medium text-slate-950" onClick={() => window.location.reload()}>Reload app</button></div></div>
    return this.props.children
  }
}
