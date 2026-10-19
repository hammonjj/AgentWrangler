/**
 * The local CA as an Apple configuration profile (#136), so an iPhone, iPad
 * or Mac can install it with a tap: `GET /ca.mobileconfig` on the loopback
 * listener.
 *
 * One payload, `com.apple.security.root`, holding the CA certificate (DER).
 * The profile is unsigned, so iOS shows it as "Not Verified"; that is expected
 * for a CA made on this Mac. Installing a root this way does not make iOS
 * trust it for TLS: that is a second, deliberate switch under Settings →
 * General → About → Certificate Trust Settings (README, "LAN access").
 *
 * UUIDs and identifiers are derived from the certificate's fingerprint, so
 * downloading the profile twice gives the same profile (iOS replaces rather
 * than duplicates it), and a new CA gives a new one.
 */
import * as crypto from 'node:crypto';

export const MOBILECONFIG_CONTENT_TYPE = 'application/x-apple-aspen-config';

export function caMobileconfig(caPem: string): string {
  const cert = new crypto.X509Certificate(caPem);
  const der = cert.raw;
  const fingerprint = crypto.createHash('sha256').update(der).digest('hex');
  const name = commonName(cert.subject) ?? 'Agent Wrangler Local CA';
  const id = `com.agentwrangler.local-ca.${fingerprint.slice(0, 16)}`;
  const base64 = der.toString('base64').replace(/(.{64})/g, '$1\n\t\t\t');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>PayloadContent</key>',
    '\t<array>',
    '\t\t<dict>',
    '\t\t\t<key>PayloadCertificateFileName</key>',
    '\t\t\t<string>agent-wrangler-ca.cer</string>',
    '\t\t\t<key>PayloadContent</key>',
    `\t\t\t<data>\n\t\t\t${base64}\n\t\t\t</data>`,
    '\t\t\t<key>PayloadDescription</key>',
    '\t\t\t<string>The root certificate Agent Wrangler on your Mac uses for its LAN address.</string>',
    '\t\t\t<key>PayloadDisplayName</key>',
    `\t\t\t<string>${xml(name)}</string>`,
    '\t\t\t<key>PayloadIdentifier</key>',
    `\t\t\t<string>${id}.cert</string>`,
    '\t\t\t<key>PayloadType</key>',
    '\t\t\t<string>com.apple.security.root</string>',
    '\t\t\t<key>PayloadUUID</key>',
    `\t\t\t<string>${uuidFrom(`payload:${fingerprint}`)}</string>`,
    '\t\t\t<key>PayloadVersion</key>',
    '\t\t\t<integer>1</integer>',
    '\t\t</dict>',
    '\t</array>',
    '\t<key>PayloadDescription</key>',
    '\t<string>Lets this device open Agent Wrangler from your Mac over HTTPS on your home network. After installing, turn on full trust under Settings, General, About, Certificate Trust Settings.</string>',
    '\t<key>PayloadDisplayName</key>',
    `\t<string>${xml(name)}</string>`,
    '\t<key>PayloadIdentifier</key>',
    `\t<string>${id}</string>`,
    '\t<key>PayloadRemovalDisallowed</key>',
    '\t<false/>',
    '\t<key>PayloadType</key>',
    '\t<string>Configuration</string>',
    '\t<key>PayloadUUID</key>',
    `\t<string>${uuidFrom(`profile:${fingerprint}`)}</string>`,
    '\t<key>PayloadVersion</key>',
    '\t<integer>1</integer>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** `CN=` out of `X509Certificate.subject` (one `KEY=value` per line). */
function commonName(subject: string): string | undefined {
  for (const line of subject.split('\n')) if (line.startsWith('CN=')) return line.slice(3);
  return undefined;
}

/** A stable, well-formed (version 4 layout) UUID from a seed. */
function uuidFrom(seed: string): string {
  const h = crypto.createHash('sha256').update(seed).digest();
  h[6] = (h[6] & 0x0f) | 0x40;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex').toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
