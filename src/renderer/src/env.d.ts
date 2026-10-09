/// <reference types="vite/client" />
import type { KazaaApi, P2pApi } from '../../shared/contracts.ts'

declare global {
  interface Window {
    p2p: P2pApi
    kazaa: KazaaApi
  }
}
