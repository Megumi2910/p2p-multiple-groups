import { useEffect, useRef, useState, useCallback } from 'react'
import type {
  ActionResult,
  ConnectOptions,
  P2pState
} from '../../../../shared/p2p.ts'

const DEFAULT_P2P_STATE: P2pState = {
  revision: 0,
  network: {
    status: 'disconnected',
    peerId: '',
    sessionId: null,
    displayName: '',
    supernodeEligible: true,
    signalingUrl: '',
    roomId: '',
    role: 'ordinary',
    epoch: null,
    membershipRevision: 0,
    primaryPeerId: null,
    standbyPeerId: null,
    members: [],
    links: [],
    message: null
  },
  library: {
    status: 'idle',
    files: [],
    advertisedGeneration: null,
    acknowledgedGeneration: null
  },
  search: {
    queryId: null,
    query: '',
    status: 'idle',
    results: [],
    message: null
  },
  transfers: [],
  recoveryEvents: []
}

export function usePeerState() {
  const [state, setState] = useState<P2pState>(DEFAULT_P2P_STATE)
  const [error, setError] = useState<string | null>(null)
  const lastRevisionRef = useRef(0)

  useEffect(() => {
    if (!window.kazaa?.p2p) {
      setError('P2P bridge unavailable')
      return
    }

    const applyState = (incoming: P2pState) => {
      if (incoming.revision >= lastRevisionRef.current) {
        lastRevisionRef.current = incoming.revision
        setState(incoming)
      }
    }

    // Subscribe before initial getState to ensure no events are missed
    const unsubscribe = window.kazaa.p2p.onState(applyState)

    window.kazaa.p2p
      .getState()
      .then(applyState)
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err))
      })

    return () => {
      unsubscribe()
    }
  }, [])

  const connect = useCallback(async (opts: ConnectOptions): Promise<ActionResult> => {
    if (!window.kazaa?.p2p) return { ok: false, code: 'IO_ERROR', message: 'P2P bridge unavailable' }
    return window.kazaa.p2p.connect(opts)
  }, [])

  const disconnect = useCallback(async (): Promise<ActionResult> => {
    if (!window.kazaa?.p2p) return { ok: false, code: 'IO_ERROR', message: 'P2P bridge unavailable' }
    return window.kazaa.p2p.disconnect()
  }, [])

  const setSupernodeEligible = useCallback(async (eligible: boolean): Promise<ActionResult> => {
    if (!window.kazaa?.p2p) return { ok: false, code: 'IO_ERROR', message: 'P2P bridge unavailable' }
    return window.kazaa.p2p.setSupernodeEligible(eligible)
  }, [])

  const addFiles = useCallback(async (): Promise<ActionResult> => {
    if (!window.kazaa?.p2p) return { ok: false, code: 'IO_ERROR', message: 'P2P bridge unavailable' }
    return window.kazaa.p2p.addFiles()
  }, [])

  const rescanLibrary = useCallback(async (): Promise<ActionResult> => {
    if (!window.kazaa?.p2p) return { ok: false, code: 'IO_ERROR', message: 'P2P bridge unavailable' }
    return window.kazaa.p2p.rescanLibrary()
  }, [])

  const removeFile = useCallback(async (fileId: string): Promise<ActionResult> => {
    if (!window.kazaa?.p2p) return { ok: false, code: 'IO_ERROR', message: 'P2P bridge unavailable' }
    return window.kazaa.p2p.removeFile(fileId)
  }, [])

  const search = useCallback(async (query: string): Promise<ActionResult> => {
    if (!window.kazaa?.p2p) return { ok: false, code: 'IO_ERROR', message: 'P2P bridge unavailable' }
    return window.kazaa.p2p.search(query)
  }, [])

  const download = useCallback(async (resultId: string): Promise<ActionResult> => {
    if (!window.kazaa?.p2p) return { ok: false, code: 'IO_ERROR', message: 'P2P bridge unavailable' }
    return window.kazaa.p2p.download(resultId)
  }, [])

  const cancelTransfer = useCallback(async (transferId: string): Promise<ActionResult> => {
    if (!window.kazaa?.p2p) return { ok: false, code: 'IO_ERROR', message: 'P2P bridge unavailable' }
    return window.kazaa.p2p.cancelTransfer(transferId)
  }, [])

  return {
    state,
    error,
    connect,
    disconnect,
    setSupernodeEligible,
    addFiles,
    rescanLibrary,
    removeFile,
    search,
    download,
    cancelTransfer
  }
}
