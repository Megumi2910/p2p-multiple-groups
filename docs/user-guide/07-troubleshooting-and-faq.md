# User Guide: Troubleshooting & FAQ

This document provides resolutions for common operational errors, NAT traversal hurdles, keychain permission edge cases, and profile recovery procedures.

---

## 1. Error Code Encyclopedia

When an operation fails, the application returns a structured `ActionResult` containing a standardized error code:

| Error Code | Trigger Condition | Root Cause & Resolution |
|---|---|---|
| `AUTH_FAILED` | Joining a group or authenticating signaling session. | The provided group token does not match the token configured on the signaling server. Verify the invitation string with your server operator. |
| `NO_SUPERNODE` | Executing search queries or publishing catalogs. | No peer in the group is currently eligible or elected as a supernode. Ensure at least one participating node checks **Supernode Eligible** in their network settings. |
| `UNREACHABLE` | Initiating a direct or relayed WebRTC transfer. | ICE candidate gathering failed to establish a DTLS session. Symmetric NATs on both sides without a configured Coturn TURN relay. Check STUN/TURN configuration. |
| `NOT_FOUND` | Downloading a file from search results. | The target peer removed the file from their library or went offline after the search result was received. Rescan search results to refresh. |
| `FILE_CHANGED` | Validating file during chunk streaming. | The file was modified on the host peer's filesystem during active transfer (mismatched size or SHA-256). The host must rescan their library. |
| `DESTINATION_EXISTS` | Saving a downloaded file to disk. | A file with identical name already exists in target folder and collision renaming failed. Choose a different download folder or rename the local file. |
| `IO_ERROR` | Reading or writing files from filesystem. | Insufficient filesystem permissions or disk full. Ensure the application has read access to shared folders and write access to the download path. |
| `BUSY` | Issuing rapid group joins or policy changes. | Another asynchronous lifecycle operation is currently active in the `policyQueue`. Await completion before issuing another state change. |
| `PROTOCOL_ERROR` | Receiving malformed wire payloads. | Version mismatch between clients or signaling server. Ensure all participants run compatible versions of `p2p-multiple-groups`. |
| `FORBIDDEN` | Accessing file or joining unauthorized group. | The file access grant was revoked for your group by the hosting peer, or your node lacks permission. |
| `INVITATION_REQUIRED` | Automatic re-joining upon application launch. | The group's credentials were not saved (e.g. remembered mode was disabled) and memory cache expired. Re-paste the invitation JSON to join. |
| `INVALID_INPUT` | Submitting form data or changing settings. | Validation failure (e.g., display name contains invalid characters, empty group ID, or attempting to toggle `relayOnly` while groups are active). |

---

## 2. Diagnosing Symmetric NAT & TURN Traversal

When two peers behind symmetric NATs attempt to connect, direct UDP hole punching fails because symmetric NATs assign unique, unpredictable external port mappings for each destination IP/port tuple.

### Symptoms
- Peer status remains stuck on `connecting`.
- Active transfer rows fail immediately with `UNREACHABLE: ICE connection failed`.
- `links` count in the Active Group details panel remains at `0`.

### Solution: Verify Coturn TURN Configuration
Ensure the signaling server has access to a working Coturn TURN relay:
1. Verify `P2P_MULTIPLE_GROUPS_TURN_HOST` and `P2P_MULTIPLE_GROUPS_TURN_SECRET` are properly configured in `.env`.
2. Inspect browser or terminal console for `ice-config` events received from the signaling server.
3. Test TURN reachability using `trickle-ice` or `turnutils_uclient`:
   ```bash
   turnutils_uclient -u testuser -w testsecret turn.yourdomain.com
   ```
4. If issues persist on enterprise networks with strict UDP firewalls, ensure Coturn is listening on port `443` over TCP and TLS.

---

## 3. Headless Linux & Keychain Recovery

On Linux systems without desktop environments (such as CI runners, Docker containers, or minimal server distributions), Electron's `safeStorage` API cannot connect to the Secret Service DBus daemon (`org.freedesktop.secrets`).

### Symptoms
- Error logged: `[CredentialStore] Hardware keychain unavailable, falling back to memory cache`.
- Group credentials are forgotten after closing the application.

### Resolution
1. **Enable Session Memory Mode**: Uncheck **Remember invitation securely** when joining groups. Credentials will remain active in memory for the duration of the session.
2. **Install Secret Service Daemon (for headless Linux)**:
   ```bash
   # Install gnome-keyring and dbus-x11
   sudo apt-get install -y gnome-keyring dbus-x11

   # Initialize DBus session before launching Electron
   eval $(dbus-launch --sh-syntax)
   echo "" | gnome-keyring-daemon --unlock
   ```

---

## 4. Profile Corruption Recovery & Backups

The application maintains automatic backups of your configuration to prevent data loss.

### Profile File Locations
- **Windows**: `%APPDATA%\p2p-multiple-groups\`
- **macOS**: `~/Library/Application Support/p2p-multiple-groups/`
- **Linux**: `~/.config/p2p-multiple-groups/`

### Primary Storage Files
- `peer-state.json`: Active V2 state file containing your persistent `peerId`, `displayName`, joined groups, and shared library entries.
- `peer-state.v1.backup.json`: Automatic backup created during migration from legacy profiles.
- `credentials.enc`: OS-encrypted group access tokens.

### Recovery Procedure
If `peer-state.json` becomes corrupted (e.g. sudden power loss during write):
1. Close the application.
2. Navigate to your application data directory.
3. If `peer-state.json.tmp` exists, delete it.
4. If `peer-state.v1.backup.json` exists, copy it over `peer-state.json`.
5. Restart the application. The store will automatically re-migrate and restore your identity and group configurations.
