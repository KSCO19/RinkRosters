import React from 'react'
import ReactDOM from 'react-dom/client'
import './mobile.css'
import RinkRosters from './RinkRostersApp'

ReactDOM.createRoot(document.getElementById('root')).render(<RinkRosters />)

// Register the service worker (installable PWA + offline). Dev server also has
// a SW served from public/, but we only register in production builds to avoid
// caching interfering with Vite HMR.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}
