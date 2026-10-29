import { StrictMode } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import App from './App.tsx'
import './styles/fonts.css'
import './index.css'
import './styles/observatory.css'
import './flow/styles/flow.css'
import './flow/styles/video-pages.css'
import './flow/styles/application.css'

const root = document.getElementById('root')!
const application = (
  <StrictMode>
    <App />
  </StrictMode>
)
// Static public documents hydrate their real component tree. Auth/private
// routes receive an empty, noindex SPA shell and use the existing client path.
if (root.dataset.prerendered === 'true') hydrateRoot(root, application)
else createRoot(root).render(application)
