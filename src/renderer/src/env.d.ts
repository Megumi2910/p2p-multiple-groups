/// <reference types="vite/client" />
import type { KazaaApi } from '../../shared/contracts.ts'

declare global {
  interface Window {
    kazaa: KazaaApi
  }
}
