import { useEffect, useRef, useState, useCallback } from 'react'
import type {
  ActionResult,
  ConnectOptions,
  GroupKey,
  JoinGroupOptions,
  MultiGroupP2pState,
  P2pState
} from '../../../../shared/p2p.ts'

export type CombinedPeerState = MultiGroupP2pState & P2pState

const DEFAULT_STATE: CombinedPeerState = {
  revision: 0,
  identity: {
    peerId: '',
    displayName: ''
  },
  relayOnly: false,
  groups: [],
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
    advertisedGeneration: 1,
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

function getBridge() {
  return window.p2p || window.kazaa
}

export function usePeerState() {
  const [state, setState] = useState<CombinedPeerState>(DEFAULT_STATE)
  const [selectedGroupKey, setSelectedGroupKey] = useState<GroupKey | null>(null)
  const [error, setError] = useState<string | null>(null)
  const lastRevisionRef = useRef(0)

  // Automatically select first group if none selected or previous group was left
  useEffect(() => {
    if (state.groups.length > 0) {
      if (!selectedGroupKey || !state.groups.some((g) => g.groupKey === selectedGroupKey)) {
        setSelectedGroupKey(state.groups[0].groupKey)
      }
    } else {
      setSelectedGroupKey(null)
    }
  }, [state.groups, selectedGroupKey])

  useEffect(() => {
    const bridge = getBridge()
    if (!bridge?.p2p) {
      setError('P2P bridge unavailable')
      return
    }

    const applyState = (incoming: CombinedPeerState) => {
      if (incoming.revision >= lastRevisionRef.current) {
        lastRevisionRef.current = incoming.revision
        setState(incoming)
      }
    }

    const unsubscribe = (bridge.p2p.onState as (listener: (state: any) => void) => () => void)(applyState)
    bridge.p2p
      .getState()
      .then((s) => applyState(s as CombinedPeerState))
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err))
      })

    return () => {
      unsubscribe()
    }
  }, [])

  const joinGroup = useCallback(async (options: JoinGroupOptions): Promise<ActionResult> => {
    const bridge = getBridge()
    if (!bridge?.p2p?.joinGroup) return { ok: false, code: 'IO_ERROR', message: 'Bridge unavailable' }
    return bridge.p2p.joinGroup(options)
  }, [])

  const resumeGroup = useCallback(async (groupKey: GroupKey): Promise<ActionResult> => {
    const bridge = getBridge()
    if (!bridge?.p2p?.resumeGroup) return { ok: false, code: 'IO_ERROR', message: 'Bridge unavailable' }
    return bridge.p2p.resumeGroup(groupKey)
  }, [])

  const leaveGroup = useCallback(async (groupKey: GroupKey): Promise<ActionResult> => {
    const bridge = getBridge()
    if (!bridge?.p2p?.leaveGroup) return { ok: false, code: 'IO_ERROR', message: 'Bridge unavailable' }
    return bridge.p2p.leaveGroup(groupKey)
  }, [])

  const setGroupAutoJoin = useCallback(async (groupKey: GroupKey, autoJoin: boolean): Promise<ActionResult> => {
    const bridge = getBridge()
    if (!bridge?.p2p?.setGroupAutoJoin) return { ok: false, code: 'IO_ERROR', message: 'Bridge unavailable' }
    return bridge.p2p.setGroupAutoJoin(groupKey, autoJoin)
  }, [])

  const forgetGroup = useCallback(async (groupKey: GroupKey): Promise<ActionResult> => {
    const bridge = getBridge()
    if (!bridge?.p2p?.forgetGroup) return { ok: false, code: 'IO_ERROR', message: 'Bridge unavailable' }
    return bridge.p2p.forgetGroup(groupKey)
  }, [])

  const disconnectAll = useCallback(async (): Promise<ActionResult> => {
    const bridge = getBridge()
    if (!bridge?.p2p?.disconnectAll) return { ok: false, code: 'IO_ERROR', message: 'Bridge unavailable' }
    return bridge.p2p.disconnectAll()
  }, [])

  const setSupernodeEligible = useCallback(async (arg1: unknown, arg2?: unknown): Promise<ActionResult> => {
    const bridge = getBridge()
    if (!bridge?.p2p?.setSupernodeEligible) return { ok: false, code: 'IO_ERROR', message: 'Bridge unavailable' }
    return (bridge.p2p.setSupernodeEligible as any)(arg1, arg2)
  }, [])

  const addFiles = useCallback(async (groupKey?: GroupKey | null): Promise<ActionResult> => {
    const bridge = getBridge()
    if (!bridge?.p2p?.addFiles) return { ok: false, code: 'IO_ERROR', message: 'Bridge unavailable' }
    return bridge.p2p.addFiles(groupKey !== undefined ? groupKey : selectedGroupKey)
  }, [selectedGroupKey])

  const rescanLibrary = useCallback(async (): Promise<ActionResult> => {
    const bridge = getBridge()
    if (!bridge?.p2p?.rescanLibrary) return { ok: false, code: 'IO_ERROR', message: 'Bridge unavailable' }
    return bridge.p2p.rescanLibrary()
  }, [])

  const removeFile = useCallback(async (fileId: string): Promise<ActionResult> => {
    const bridge = getBridge()
    if (!bridge?.p2p?.removeFile) return { ok: false, code: 'IO_ERROR', message: 'Bridge unavailable' }
    return bridge.p2p.removeFile(fileId)
  }, [])

  const setFileGroups = useCallback(async (fileId: string, groupKeys: GroupKey[]): Promise<ActionResult> => {
    const bridge = getBridge()
    if (!bridge?.p2p?.setFileGroups) return { ok: false, code: 'IO_ERROR', message: 'Bridge unavailable' }
    return bridge.p2p.setFileGroups(fileId, groupKeys)
  }, [])

  const search = useCallback(async (arg1: string, arg2?: string): Promise<ActionResult> => {
    const bridge = getBridge()
    if (!bridge?.p2p?.search) return { ok: false, code: 'IO_ERROR', message: 'Bridge unavailable' }
    if (arg2 !== undefined) {
      return bridge.p2p.search(arg1, arg2)
    }
    const gk = selectedGroupKey || state.groups[0]?.groupKey || ''
    return bridge.p2p.search(gk, arg1)
  }, [selectedGroupKey, state.groups])

  const download = useCallback(async (arg1: string, arg2?: string): Promise<ActionResult> => {
    const bridge = getBridge()
    if (!bridge?.p2p?.download) return { ok: false, code: 'IO_ERROR', message: 'Bridge unavailable' }
    if (arg2 !== undefined) {
      return bridge.p2p.download(arg1, arg2)
    }
    const gk = selectedGroupKey || state.groups[0]?.groupKey || ''
    return bridge.p2p.download(gk, arg1)
  }, [selectedGroupKey, state.groups])

  const cancelTransfer = useCallback(async (transferId: string): Promise<ActionResult> => {
    const bridge = getBridge()
    if (!bridge?.p2p?.cancelTransfer) return { ok: false, code: 'IO_ERROR', message: 'Bridge unavailable' }
    return bridge.p2p.cancelTransfer(transferId)
  }, [])

  // Legacy connect / disconnect compatibility
  const connect = useCallback(async (opts: ConnectOptions): Promise<ActionResult> => {
    const bridge = getBridge()
    if (!bridge?.p2p?.connect) return { ok: false, code: 'IO_ERROR', message: 'Bridge unavailable' }
    return bridge.p2p.connect(opts)
  }, [])

  const disconnect = useCallback(async (): Promise<ActionResult> => {
    const bridge = getBridge()
    if (!bridge?.p2p?.disconnect) return { ok: false, code: 'IO_ERROR', message: 'Bridge unavailable' }
    return bridge.p2p.disconnect()
  }, [])

  return {
    state,
    selectedGroupKey,
    setSelectedGroupKey,
    error,
    joinGroup,
    resumeGroup,
    leaveGroup,
    setGroupAutoJoin,
    forgetGroup,
    disconnectAll,
    setSupernodeEligible,
    addFiles,
    rescanLibrary,
    removeFile,
    setFileGroups,
    search,
    download,
    cancelTransfer,
    connect,
    disconnect
  }
}
