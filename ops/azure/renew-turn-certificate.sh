#!/usr/bin/env bash
# Certbot Deploy Hook for p2p-multiple-groups Helper
# Install to /etc/letsencrypt/renewal-hooks/deploy/p2p-renew.sh and chmod +x
# Triggered automatically upon successful Let's Encrypt certificate renewal.

set -euo pipefail

DOMAIN="${RENEWED_DOMAINS:-}"
LINEAGE="${RENEWED_LINEAGE:-}"

if [[ -z "$LINEAGE" ]]; then
    echo "[p2p-renew] RENEWED_LINEAGE is not set; exiting."
    exit 1
fi

echo "[p2p-renew] Renewed certificate for lineage: $LINEAGE"

# 1. Update Coturn TLS certificates
COTURN_CERT_DIR="/etc/coturn/certs"
mkdir -p "$COTURN_CERT_DIR"

# Copy certificate chain and private key
cp -L "$LINEAGE/fullchain.pem" "$COTURN_CERT_DIR/turn_server_cert.pem"
cp -L "$LINEAGE/privkey.pem" "$COTURN_CERT_DIR/turn_server_pkey.pem"

# Protect private key: root ownership, coturn group, read-only to service (mode 0640)
# NEVER make private keys or /etc/letsencrypt world-readable!
chown -R root:coturn "$COTURN_CERT_DIR"
chmod 0750 "$COTURN_CERT_DIR"
chmod 0640 "$COTURN_CERT_DIR/turn_server_cert.pem"
chmod 0640 "$COTURN_CERT_DIR/turn_server_pkey.pem"

# 2. Restart Coturn to load updated TLS certificates
echo "[p2p-renew] Restarting coturn service..."
systemctl restart coturn

# 3. Reload Nginx to load updated HTTPS certificate
echo "[p2p-renew] Reloading nginx service..."
systemctl reload nginx

echo "[p2p-renew] Certificate renewal deployment completed successfully."
