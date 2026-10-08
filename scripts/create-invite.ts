import { validateRoomId, validateSignalingUrl, validateToken, type NetworkInvitation } from '../src/shared/p2p.ts'

function main(): void {
  const rawUrl = process.env.KAZAA_PUBLIC_SIGNAL_URL || ''
  const urlCheck = validateSignalingUrl(rawUrl)
  if (!urlCheck.valid) {
    console.error(`Invalid KAZAA_PUBLIC_SIGNAL_URL: ${urlCheck.error}`)
    process.exit(1)
  }

  const rawRoom = process.env.KAZAA_ROOM_ID || ''
  const roomCheck = validateRoomId(rawRoom)
  if (!roomCheck.valid) {
    console.error(`Invalid KAZAA_ROOM_ID: ${roomCheck.error}`)
    process.exit(1)
  }

  const rawToken = process.env.KAZAA_ROOM_TOKEN || ''
  const tokenCheck = validateToken(rawToken)
  if (!tokenCheck.valid) {
    console.error(`Invalid KAZAA_ROOM_TOKEN: ${tokenCheck.error}`)
    process.exit(1)
  }

  const invitation: NetworkInvitation = {
    version: 1,
    signalingUrl: urlCheck.url,
    roomId: roomCheck.value,
    token: tokenCheck.value
  }

  console.log(JSON.stringify(invitation, null, 2))
}

main()
