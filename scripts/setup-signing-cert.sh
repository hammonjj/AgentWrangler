#!/bin/bash
#
# Create the self-signed code-signing certificate local builds are signed with.
#
# Why: macOS privacy grants (Screen Recording, Accessibility, microphone) are
# pinned to the app's *designated requirement*. An ad-hoc signature has none
# worth the name — it is the build's code hash — so every rebuild made every
# earlier grant stale while System Settings still showed the switch on. A
# certificate in the login keychain gives a requirement of "this bundle id,
# signed by this certificate", which stays the same across rebuilds.
#
# One per machine; run it once. It is idempotent: an existing, trusted
# certificate is left alone. macOS asks for your login password once, to trust
# the certificate for code signing, and the first build may ask whether
# `codesign` may use the key — choose "Always Allow".
#
# Replaced by a real Apple Development / Developer ID certificate when the app
# is distributed to other machines (see issue #57).
set -euo pipefail

NAME="Agent Wrangler Local Signing"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -v -p codesigning "$KEYCHAIN" | grep -q "\"$NAME\""; then
  echo "\"$NAME\" is already installed and trusted for code signing."
  exit 0
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if ! security find-certificate -c "$NAME" "$KEYCHAIN" >/dev/null 2>&1; then
  cat >"$TMP/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
EOF

  # /usr/bin/openssl (LibreSSL) on purpose: its PKCS#12 defaults are the ones
  # `security import` reads. Homebrew's OpenSSL 3 writes a format it rejects
  # unless given -legacy.
  /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -config "$TMP/cert.cnf" -keyout "$TMP/key.pem" -out "$TMP/cert.pem" 2>/dev/null
  PASS=$(/usr/bin/openssl rand -hex 16)
  /usr/bin/openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
    -name "$NAME" -passout "pass:$PASS" -out "$TMP/cert.p12"

  # -T lets codesign use the private key without a prompt on every build.
  security import "$TMP/cert.p12" -k "$KEYCHAIN" -P "$PASS" -T /usr/bin/codesign >/dev/null
  echo "Imported \"$NAME\" into the login keychain."
else
  security find-certificate -c "$NAME" -p "$KEYCHAIN" >"$TMP/cert.pem"
fi

# Self-signed, so nothing vouches for it until you do. Without this it is not a
# *valid* identity, and electron-builder only looks at valid ones.
echo "Trusting it for code signing — macOS will ask for your login password."
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$TMP/cert.pem"

security find-identity -v -p codesigning "$KEYCHAIN" | grep "\"$NAME\""
echo "Done. Builds are now signed as \"$NAME\"."
