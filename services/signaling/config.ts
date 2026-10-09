import {
  validateDisplayName,
  validateGroupId,
  validateRoomId,
  validateSignalingUrl,
  validateToken
} from '../../src/shared/p2p.ts'
import type { SignalingOptions } from './server.ts'

export interface ParsedSignalingConfig extends SignalingOptions {
  publicSignalUrl?: string
}

export function loadSignalingOptions(env: NodeJS.ProcessEnv = process.env): ParsedSignalingConfig {
  // Determine Host & Port
  let host = env.P2P_MULTIPLE_GROUPS_SIGNAL_HOST
  if (!host && env.KAZAA_SIGNAL_HOST) {
    host = env.KAZAA_SIGNAL_HOST
  }
  if (!host) {
    host = env.RENDER || env.PORT ? '0.0.0.0' : '127.0.0.1'
  }

  let rawPort = env.P2P_MULTIPLE_GROUPS_SIGNAL_PORT
  if (rawPort && env.KAZAA_SIGNAL_PORT && rawPort !== env.KAZAA_SIGNAL_PORT) {
    console.warn('[config] Deprecation warning: both P2P_MULTIPLE_GROUPS_SIGNAL_PORT and KAZAA_SIGNAL_PORT are set; using P2P_MULTIPLE_GROUPS_SIGNAL_PORT')
  }
  if (!rawPort) {
    rawPort = env.KAZAA_SIGNAL_PORT || env.PORT || '8787'
  }

  const port = parseInt(rawPort, 10)
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid signaling port: ${rawPort}`)
  }

  // Groups configuration
  let groups: Array<{ groupId: string; token: string }> = []
  const rawGroupsJson = env.P2P_MULTIPLE_GROUPS_GROUPS_JSON

  if (rawGroupsJson) {
    let parsed: unknown
    try {
      parsed = JSON.parse(rawGroupsJson)
    } catch {
      throw new Error('P2P_MULTIPLE_GROUPS_GROUPS_JSON must be valid JSON')
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('P2P_MULTIPLE_GROUPS_GROUPS_JSON must be a non-empty array of group definitions')
    }

    const seenGroupIds = new Set<string>()
    const seenTokens = new Set<string>()

    for (let i = 0; i < parsed.length; i++) {
      const item = parsed[i] as unknown
      if (!item || typeof item !== 'object') {
        throw new Error(`Group entry at index ${i} must be an object`)
      }
      const g = item as Record<string, unknown>
      if (typeof g.groupId !== 'string') {
        throw new Error(`Group entry at index ${i} has invalid or missing groupId`)
      }
      const groupCheck = validateGroupId(g.groupId)
      if (!groupCheck.valid) {
        throw new Error(`Group entry at index ${i} has invalid groupId: ${groupCheck.error}`)
      }
      if (typeof g.token !== 'string') {
        throw new Error(`Group entry at index ${i} has missing token`)
      }
      const tokenCheck = validateToken(g.token)
      if (!tokenCheck.valid) {
        throw new Error(`Group entry at index ${i} has invalid token: ${tokenCheck.error}`)
      }

      if (seenGroupIds.has(groupCheck.value)) {
        throw new Error(`Duplicate groupId in group configuration: "${groupCheck.value}"`)
      }
      if (seenTokens.has(tokenCheck.value)) {
        throw new Error('Duplicate token in group configuration; tokens across groups must be distinct')
      }

      seenGroupIds.add(groupCheck.value)
      seenTokens.add(tokenCheck.value)
      groups.push({
        groupId: groupCheck.value,
        token: tokenCheck.value
      })
    }
  } else {
    // Legacy single room fallback: KAZAA_ROOM_ID & KAZAA_ROOM_TOKEN
    const rawRoom = env.KAZAA_ROOM_ID
    const rawToken = env.KAZAA_ROOM_TOKEN

    if (!rawRoom || !rawToken) {
      throw new Error(
        'Missing group configuration: P2P_MULTIPLE_GROUPS_GROUPS_JSON (or legacy KAZAA_ROOM_ID and KAZAA_ROOM_TOKEN) is required'
      )
    }

    const roomCheck = validateRoomId(rawRoom)
    if (!roomCheck.valid) {
      throw new Error(`Invalid legacy KAZAA_ROOM_ID: ${roomCheck.error}`)
    }
    const tokenCheck = validateToken(rawToken)
    if (!tokenCheck.valid) {
      throw new Error(`Invalid legacy KAZAA_ROOM_TOKEN: ${tokenCheck.error}`)
    }

    groups.push({
      groupId: roomCheck.value,
      token: tokenCheck.value
    })
  }

  // Public Signal URL
  let publicSignalUrl = env.P2P_MULTIPLE_GROUPS_PUBLIC_SIGNAL_URL
  if (publicSignalUrl && env.KAZAA_PUBLIC_SIGNAL_URL && publicSignalUrl !== env.KAZAA_PUBLIC_SIGNAL_URL) {
    console.warn('[config] Deprecation warning: both P2P_MULTIPLE_GROUPS_PUBLIC_SIGNAL_URL and KAZAA_PUBLIC_SIGNAL_URL are set; using P2P_MULTIPLE_GROUPS_PUBLIC_SIGNAL_URL')
  }
  if (!publicSignalUrl) {
    publicSignalUrl = env.KAZAA_PUBLIC_SIGNAL_URL
  }
  if (publicSignalUrl) {
    const urlCheck = validateSignalingUrl(publicSignalUrl)
    if (!urlCheck.valid) {
      throw new Error(`Invalid public signaling URL: ${urlCheck.error}`)
    }
    publicSignalUrl = urlCheck.url
  }

  // STUN URL
  let stunUrl = env.P2P_MULTIPLE_GROUPS_STUN_URL
  if (stunUrl && env.KAZAA_STUN_URL && stunUrl !== env.KAZAA_STUN_URL) {
    console.warn('[config] Deprecation warning: both P2P_MULTIPLE_GROUPS_STUN_URL and KAZAA_STUN_URL are set')
  }
  if (!stunUrl) {
    stunUrl = env.KAZAA_STUN_URL
  }

  // Dynamic HMAC TURN (host + secret)
  let turnHost = env.P2P_MULTIPLE_GROUPS_TURN_HOST
  if (turnHost && env.KAZAA_TURN_HOST && turnHost !== env.KAZAA_TURN_HOST) {
    console.warn('[config] Deprecation warning: both P2P_MULTIPLE_GROUPS_TURN_HOST and KAZAA_TURN_HOST are set')
  }
  if (!turnHost) {
    turnHost = env.KAZAA_TURN_HOST
  }

  let turnSecret = env.P2P_MULTIPLE_GROUPS_TURN_SECRET
  if (turnSecret && env.KAZAA_TURN_SECRET && turnSecret !== env.KAZAA_TURN_SECRET) {
    console.warn('[config] Deprecation warning: both P2P_MULTIPLE_GROUPS_TURN_SECRET and KAZAA_TURN_SECRET are set')
  }
  if (!turnSecret) {
    turnSecret = env.KAZAA_TURN_SECRET
  }

  if ((turnHost && !turnSecret) || (!turnHost && turnSecret)) {
    throw new Error('TURN_HOST and TURN_SECRET must be both set or both absent')
  }

  // Managed TURN credentials
  let turnUrl = env.P2P_MULTIPLE_GROUPS_TURN_URL
  if (turnUrl && env.KAZAA_TURN_URL && turnUrl !== env.KAZAA_TURN_URL) {
    console.warn('[config] Deprecation warning: both P2P_MULTIPLE_GROUPS_TURN_URL and KAZAA_TURN_URL are set')
  }
  if (!turnUrl) {
    turnUrl = env.KAZAA_TURN_URL
  }

  let turnUsername = env.P2P_MULTIPLE_GROUPS_TURN_USERNAME
  if (turnUsername && env.KAZAA_TURN_USERNAME && turnUsername !== env.KAZAA_TURN_USERNAME) {
    console.warn('[config] Deprecation warning: both P2P_MULTIPLE_GROUPS_TURN_USERNAME and KAZAA_TURN_USERNAME are set')
  }
  if (!turnUsername) {
    turnUsername = env.KAZAA_TURN_USERNAME
  }

  let turnCredential = env.P2P_MULTIPLE_GROUPS_TURN_CREDENTIAL
  if (turnCredential && env.KAZAA_TURN_CREDENTIAL && turnCredential !== env.KAZAA_TURN_CREDENTIAL) {
    console.warn('[config] Deprecation warning: both P2P_MULTIPLE_GROUPS_TURN_CREDENTIAL and KAZAA_TURN_CREDENTIAL are set')
  }
  if (!turnCredential) {
    turnCredential = env.KAZAA_TURN_CREDENTIAL
  }

  const hasAnyManagedTurn = Boolean(turnUrl || turnUsername || turnCredential)
  const hasAllManagedTurn = Boolean(turnUrl && turnUsername && turnCredential)
  if (hasAnyManagedTurn && !hasAllManagedTurn) {
    throw new Error('TURN_URL, TURN_USERNAME, and TURN_CREDENTIAL must all be set together')
  }

  return {
    host,
    port,
    groups,
    publicSignalUrl: publicSignalUrl || undefined,
    stunUrl: stunUrl || undefined,
    turnHost: turnHost || undefined,
    turnSecret: turnSecret || undefined,
    turnUrl: turnUrl || undefined,
    turnUsername: turnUsername || undefined,
    turnCredential: turnCredential || undefined
  }
}
