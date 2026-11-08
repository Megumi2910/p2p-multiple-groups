import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

function p2pCsp(isDev: boolean): Plugin {
  const devCsp =
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:5173; object-src 'none'; base-uri 'none'; form-action 'none'"
  const prodCsp =
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"

  return {
    name: 'p2p-csp',
    transformIndexHtml(html: string): string {
      return html.replace('%P2P_CSP%', isDev ? devCsp : prodCsp)
    }
  }
}

export default defineConfig(({ command }) => {
  const isDev = command === 'serve'

  return {
    main: {
      build: {
        rollupOptions: {
          output: {
            format: 'es',
            entryFileNames: 'index.js'
          }
        }
      }
    },
    preload: {
      build: {
        rollupOptions: {
          output: {
            format: 'cjs',
            entryFileNames: 'index.cjs'
          }
        }
      }
    },
    renderer: {
      plugins: [react(), p2pCsp(isDev)],
      server: {
        host: '127.0.0.1',
        port: 5173,
        strictPort: true
      }
    }
  }
})
