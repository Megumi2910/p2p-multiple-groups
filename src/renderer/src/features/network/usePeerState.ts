import { useEffect, useRef, useState, useCallback } from 'react'
import type {
  ActionResult,
  CreateGroupOptions,
  GroupKey,
  JoinGroupOptions,
  MultiGroupP2pState
} from '../../../../shared/p2p.ts'

const DEFAULT_STATE: MultiGroupP2pState = {
  revision: 0,
  identity: {
    peerId: '',
    displayName: ''
  },
  defaultSignalingUrl: 'ws://127.0.0.1:8787/signal',
  relayOnly: false,
  groups: [],
  library: {
    status: 'idle',
    files: []
  },
  transfers: []
}

function getBridge() {
  return window.p2p
}

export function usePeerState() {
  const [state, setState] = useState<MultiGroupP2pState>(DEFAULT_STATE)
  const [selectedGroupKey, setSelectedGroupKey] = useState<GroupKey | null>(null)
  const [error, setError] = useState<string | null>(null)
  const lastRevisionRef = useRef(0)

  // Automatically select first group if none selected or previous group was left
  useEffect(() => {
    if (state.groups.length > 0) {
      const exists = state.groups.some((g) => g.groupKey === selectedGroupKey)
      if (!selectedGroupKey || !exists) {
        setSelectedGroupKey(state.groups[0].groupKey)
      }
    } else {
      setSelectedGroupKey(null)
    }
  }, [state.groups, selectedGroupKey])

  useEffect(() => {
    const bridge = getBridge()
    if (!bridge?.p2p) return

    bridge.p2p
      .getState()
      .then((s) => {
        if (s && s.revision >= lastRevisionRef.current) {
          lastRevisionRef.current = s.revision
          setState(s)
        }
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err))
      })

    const unsubscribe = bridge.p2p.onState((s) => {
      if (s && s.revision >= lastRevisionRef.current) {
        lastRevisionRef.current = s.revision
        setState(s)
      }
    })

    return () => {
      unsubscribe()
    }
  }, [])

  const createGroup = useCallback(async (options: CreateGroupOptions): Promise<ActionResult> => {
    const bridge = getBridge()
    if (!bridge?.p2p?.createGroup) return { ok: false, code: 'IO_ERROR', message: 'Bridge unavailable' }
    return bridge.p2p.createGroup(options)
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

  const rotateGroupInvite = useCallback(async (groupKey: GroupKey): Promise<ActionResult> => {
    const bridge = getBridge()
    if (!bridge?.p2p?.rotateGroupInvite) return { ok: false, code: 'IO_ERROR', message: 'Bridge unavailable' }
    return bridge.p2p.rotateGroupInvite(groupKey)
  }, [])

  const removeGroupMember = useCallback(async (groupKey: GroupKey, targetPeerId: string): Promise<ActionResult> => {
    const bridge = getBridge()
    if (!bridge?.p2p?.removeGroupMember) return { ok: false, code: 'IO_ERROR', message: 'Bridge unavailable' }
    return bridge.p2p.removeGroupMember(groupKey, targetPeerId)
  }, [])

  const setGroupAutoJoin = useCallback(async (groupKey: GroupKey, autoJoin: boolean): Promise<ActionResult> => {
    const bridge = getBridge()
    if (!bridge?.p2p?.setGroupAutoJoin) return { ok: false, code: 'IO_ERROR', message: 'Bridge unavailable' }
    return bridge.p2p.setGroupAutoJoin(groupKey, autoJoin)
  }, [])

  const setGroupEligibility = useCallback(async (groupKey: GroupKey, eligible: boolean): Promise<ActionResult> => {
    const bridge = getBridge()
    if (!bridge?.p2p?.setGroupEligibility) return { ok: false, code: 'IO_ERROR', message: 'Bridge unavailable' }
    return bridge.p2p.setGroupEligibility(groupKey, eligible)
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

  const search = useCallback(async (groupKey: GroupKey, query: string): Promise<ActionResult> => {
    const bridge = getBridge()
    if (!bridge?.p2p?.search) return { ok: false, code: 'IO_ERROR', message: 'Bridge unavailable' }
    return bridge.p2p.search(groupKey, query)
  }, [])

  const download = useCallback(async (groupKey: GroupKey, resultId: string): Promise<ActionResult> => {
    const bridge = getBridge()
    if (!bridge?.p2p?.download) return { ok: false, code: 'IO_ERROR', message: 'Bridge unavailable' }
    return bridge.p2p.download(groupKey, resultId)
  }, [])

  const cancelTransfer = useCallback(async (transferId: string): Promise<ActionResult> => {
    const bridge = getBridge()
    if (!bridge?.p2p?.cancelTransfer) return { ok: false, code: 'IO_ERROR', message: 'Bridge unavailable' }
    return bridge.p2p.cancelTransfer(transferId)
  }, [])

  return {
    state,
    selectedGroupKey,
    setSelectedGroupKey,
    error,
    createGroup,
    joinGroup,
    resumeGroup,
    leaveGroup,
    rotateGroupInvite,
    removeGroupMember,
    setGroupAutoJoin,
    setGroupEligibility,
    forgetGroup,
    disconnectAll,
    addFiles,
    rescanLibrary,
    removeFile,
    setFileGroups,
    search,
    download,
    cancelTransfer
  }
}
