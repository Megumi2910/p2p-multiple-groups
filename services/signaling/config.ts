import {
  validateGroupId,
  validateInviteCode,
  validateSignalingUrl
} from '../../src/shared/p2p.ts'
import type { SignalingOptions } from './server.ts'

export interface ParsedSignalingConfig extends SignalingOptions {
  publicSignalUrl?: string
}

export function loadSignalingOptions(env: NodeJS.ProcessEnv = process.env): ParsedSignalingConfig {
  // Determine Host & Port
  const host =
    env.P2P_MULTIPLE_GROUPS_SIGNAL_HOST || (env.RENDER || env.PORT ? '0.0.0.0' : '127.0.0.1')

  const rawPort = env.P2P_MULTIPLE_GROUPS_SIGNAL_PORT || env.PORT || '8787'
  const port = parseInt(rawPort, 10)
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid signaling port: ${rawPort}`)
  }

  // Groups configuration
  const groups: Array<{ groupId: string; token: string }> = []
  const rawGroupsJson = env.P2P_MULTIPLE_GROUPS_GROUPS_JSON

  if (rawGroupsJson && rawGroupsJson.trim().length > 0) {
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
      const tokenCheck = validateInviteCode(g.token)
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
  }

  // Public Signal URL
  let publicSignalUrl = env.P2P_MULTIPLE_GROUPS_PUBLIC_SIGNAL_URL
  if (publicSignalUrl) {
    const urlCheck = validateSignalingUrl(publicSignalUrl)
    if (!urlCheck.valid) {
      throw new Error(`Invalid public signaling URL: ${urlCheck.error}`)
    }
    publicSignalUrl = urlCheck.url
  }

  // STUN URL
  const stunUrl = env.P2P_MULTIPLE_GROUPS_STUN_URL

  // Dynamic HMAC TURN (host + secret)
  const turnHost = env.P2P_MULTIPLE_GROUPS_TURN_HOST
  const turnSecret = env.P2P_MULTIPLE_GROUPS_TURN_SECRET

  if ((turnHost && !turnSecret) || (!turnHost && turnSecret)) {
    throw new Error('TURN_HOST and TURN_SECRET must be both set or both absent')
  }

  // Managed TURN credentials
  const turnUrl = env.P2P_MULTIPLE_GROUPS_TURN_URL
  const turnUsername = env.P2P_MULTIPLE_GROUPS_TURN_USERNAME
  const turnCredential = env.P2P_MULTIPLE_GROUPS_TURN_CREDENTIAL

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
