import { loadSignalingOptions } from '../services/signaling/config.ts'
import type { GroupInvitation } from '../src/shared/p2p.ts'

function main(): void {
  let config
  try {
    config = loadSignalingOptions(process.env)
  } catch (err) {
    console.error(`Configuration error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  const publicUrl = config.publicSignalUrl
  if (!publicUrl) {
    console.error('Public signaling URL is not configured (set P2P_MULTIPLE_GROUPS_PUBLIC_SIGNAL_URL or KAZAA_PUBLIC_SIGNAL_URL)')
    process.exit(1)
  }

  const groups = config.groups || []
  if (groups.length === 0) {
    console.error('No groups configured')
    process.exit(1)
  }

  // Parse CLI arguments for --group-id
  let requestedGroupId: string | null = null
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i]
    if (arg.startsWith('--group-id=')) {
      requestedGroupId = arg.slice('--group-id='.length).trim()
    } else if (arg === '--group-id' && i + 1 < process.argv.length) {
      requestedGroupId = process.argv[i + 1].trim()
      i++
    }
  }

  let selectedGroup: { groupId: string; token: string } | null = null

  if (groups.length === 1) {
    if (requestedGroupId && requestedGroupId !== groups[0].groupId) {
      console.error(`Group "${requestedGroupId}" not found in configured groups`)
      process.exit(1)
    }
    selectedGroup = groups[0]
  } else {
    // Multiple groups exist: require explicit selection
    if (!requestedGroupId) {
      const availableIds = groups.map((g) => g.groupId).join(', ')
      console.error(`Multiple groups configured (${availableIds}). Please specify --group-id=<id>`)
      process.exit(1)
    }
    selectedGroup = groups.find((g) => g.groupId === requestedGroupId) || null
    if (!selectedGroup) {
      console.error(`Group "${requestedGroupId}" not found in configured groups`)
      process.exit(1)
    }
  }

  const invitation: GroupInvitation = {
    version: 2,
    signalingUrl: publicUrl,
    groupId: selectedGroup.groupId,
    token: selectedGroup.token
  }

  console.log(JSON.stringify(invitation, null, 2))
}

main()
