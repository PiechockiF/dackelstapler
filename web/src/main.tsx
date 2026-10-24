import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import 'maplibre-gl/dist/maplibre-gl.css'
import './index.css'
import App from './App.tsx'
import { isLocalMode } from './lib/mode'
import { AppErrorBoundary } from './lib/AppErrorBoundary'

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: isLocalMode ? false : 2, refetchOnWindowFocus: !isLocalMode } } })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppErrorBoundary><App /></AppErrorBoundary>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
