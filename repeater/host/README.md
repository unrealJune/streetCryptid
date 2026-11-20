# Desktop repeater connection settings

Windows, macOS and Linux use this shared host. **Network and collector** in Windows Settings,
**Network & collector** in macOS Settings, and `streetcryptid-repeater network` on Linux expose
the same configuration.

- Set up to eight iroh relay URLs, each with its own optional bearer access key.
  An empty list restores iroh's public defaults; a nonempty list replaces them.
- Set an **OTLP HTTP base URL**, for example `https://collector.example/otlp`.
  The exporter appends `/v1/traces` and `/v1/logs`. Blank restores the build's
  `SC_REPEATER_OTEL_ENDPOINT` default (or no collector if there is none).
- **Send diagnostics** is still a separate opt-in. Setting a URL never enables collection.
  Only use a collector you trust with diagnostic metadata: it can receive peer identifiers,
  timing and traffic information, though never decrypted locations.
- Use HTTPS; HTTP is accepted only for loopback collectors/relays. URLs cannot contain user
  credentials, query strings or fragments. Relay URLs must be origins, not paths.

**Save, then restart the repeater to apply.** The status reports `restartRequired` until the
running settings match. On macOS, Quit Repeater and reopen it. On Windows, quit and reopen a
per-user repeater; in service mode restart `StreetCryptidRepeater` through Windows Services as
an administrator. On Linux, restart `run`, or use
`systemctl --user restart streetcryptid-repeater` (system service: `sudo systemctl restart
streetcryptid-repeater`). The identity, roster and grants survive; in-memory ciphertext refills
from phones. No new claim is needed.

## Linux

`streetcryptid-repeater network` shows saved URLs, whether each has a key, and restart status.
To change it, prepare a private JSON file (`chmod 600 network.json`) outside the repository:

```json
{
  "relays": [
    { "url": "https://relay.example", "authToken": "YOUR-RELAY-ACCESS-KEY" },
    { "url": "https://another-relay.example" }
  ],
  "telemetryEndpoint": "https://collector.example/otlp"
}
```

```sh
streetcryptid-repeater network --file network.json
streetcryptid-repeater settings --telemetry on
```

`--file -` reads from stdin. Never put real keys in command arguments, shell history, screenshots
or source control. Remove the input file when it is no longer needed.

## Persistence and wire

`network-settings.json` lives beside the host identity and moves with it into/out of service mode.
It contains plaintext access keys protected by the state directory's ACL (Windows) and mode 0600
(Unix), not by encryption at rest. Back it up as securely as the identity. An invalid saved file
fails startup instead of silently switching a private deployment to public relays.

Protocol 2 gains an optional `network` object in snapshots and a `network` command:

```json
{
  "protocol": 2,
  "kind": "network",
  "requestId": "example",
  "network": { "relays": [], "telemetryEndpoint": "" }
}
```

Commands replace the relay list and collector URL. `authToken` omitted or null keeps the saved
key for the same normalized URL; `""` clears it. A new URL never inherits another URL's key.
The GUI's blank password preserves it; **Clear saved key** removes it. Snapshots return
`hasAuthToken`, never the key. Keys are not printed by the CLI or included in debug formatting.
The existing 4 KiB command limit still applies.

Clients show the editor only when a host advertises `network`; update both app and service before
using it. Older commands and settings files are unchanged. Invalid URLs are refused as a command
result without disconnecting the client or interrupting the running repeater.
