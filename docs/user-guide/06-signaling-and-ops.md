# User Guide: Signaling Server & Operations

The signaling server coordinates peer discovery, SDP offer/answer exchange, dynamic Coturn TURN credentials, and authoritative membership leases for all virtual groups.

---

## 1. Quick Start: Local Signaling Server

To start the signaling server for local development or private testing:

```bash
# Start signaling server on ws://127.0.0.1:8787/signal
npm run signal:start
```

By default, the server binds to `127.0.0.1:8787` and loads configuration from the local `.env` file (if present).

---

## 2. Environment Configuration (`.env`)

The signaling service is configured via environment variables. Create a `.env` file in the project root:

```ini
# Host and Port Configuration
P2P_MULTIPLE_GROUPS_SIGNAL_HOST=127.0.0.1
P2P_MULTIPLE_GROUPS_SIGNAL_PORT=8787

# Public URL advertised to peers in invitations (ws:// or wss://)
P2P_MULTIPLE_GROUPS_PUBLIC_SIGNAL_URL=ws://127.0.0.1:8787/signal

# Multi-Group JSON Definition
# Array of objects with unique groupId and secret token
P2P_MULTIPLE_GROUPS_GROUPS_JSON=[{"groupId":"engineering-team","token":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"},{"groupId":"research-docs","token":"fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"}]

# STUN Server (Optional, for NAT discovery)
P2P_MULTIPLE_GROUPS_STUN_URL=stun:stun.l.google.com:19302

# Dynamic Ephemeral TURN Relay (Optional, for Symmetric NAT bypass)
P2P_MULTIPLE_GROUPS_TURN_HOST=turn.example.com:3478
P2P_MULTIPLE_GROUPS_TURN_SECRET=your-shared-coturn-secret-here
```

### Configuration Variables Reference

| Variable Name | Required | Default | Description |
|---|---|---|---|
| `P2P_MULTIPLE_GROUPS_SIGNAL_HOST` | No | `127.0.0.1` (`0.0.0.0` in cloud) | Network interface to bind. |
| `P2P_MULTIPLE_GROUPS_SIGNAL_PORT` | No | `8787` (or `$PORT`) | TCP port for HTTP and WebSocket listeners. |
| `P2P_MULTIPLE_GROUPS_PUBLIC_SIGNAL_URL` | For Invites | — | Canonical public WebSocket URL (e.g. `wss://signal.yourdomain.com/signal`). |
| `P2P_MULTIPLE_GROUPS_GROUPS_JSON` | Yes | — | JSON array containing `{ groupId, token }` records. |
| `P2P_MULTIPLE_GROUPS_STUN_URL` | No | — | STUN server URL formatted as `stun:<host>:<port>`. |
| `P2P_MULTIPLE_GROUPS_TURN_HOST` | No | — | FQDN or IP of Coturn TURN relay. |
| `P2P_MULTIPLE_GROUPS_TURN_SECRET` | If TURN host set | — | Shared static secret for RFC 5766 HMAC-SHA1 credential generation. |

*Note: Configuration is loaded automatically from the root `.env` file or container environment variables via standard `P2P_MULTIPLE_GROUPS_*` parameters.*
---

## 3. Generating Group Invitations

Peers require an invitation JSON containing the public signaling URL, the group ID, and the cryptographic access token. Use the built-in CLI utility to generate invitations:

```bash
# If multiple groups are configured, specify the desired target group:
npm run signal:invite -- --group-id=engineering-team
```

The script outputs a formatted V2 invitation JSON:
```json
{
  "version": 2,
  "signalingUrl": "ws://127.0.0.1:8787/signal",
  "groupId": "engineering-team",
  "token": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

Distribute this invitation string securely (via encrypted chat, email, or password manager) to authorized team members.

---

## 4. HTTP Health Monitoring (`GET /healthz`)

The signaling server provides a dedicated HTTP endpoint for container orchestrators (Kubernetes, Docker Swarm), load balancers, and monitoring agents:

```bash
# Check health status
curl -i http://127.0.0.1:8787/healthz
```

**Expected Response**:
```http
HTTP/1.1 200 OK
Content-Type: application/json
Date: Thu, 20 Feb 2026 12:00:00 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Content-Length: 11

{"ok":true}
```

Any HTTP request to other paths (e.g. `GET /`) returns `404 Not Found`. WebSocket upgrade handshakes must target `/signal`.
