/// <reference types="vite/client" />
import type { P2pApi } from '../../shared/contracts.ts'

declare global {
  interface Window {
    p2p: P2pApi
  }
}
