import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { demoApi } from './lib/demo'

if (
  import.meta.env.DEV &&
  new URLSearchParams(location.search).get('demo') === '1' &&
  !window.usage
) {
  window.usage = demoApi
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
