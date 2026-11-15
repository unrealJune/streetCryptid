# Linux repeater

One binary, `streetcryptid-repeater`, that is both the repeater and every way of managing it. It
runs the same node as the Windows repeater (`repeater/host`, on the server crate's
`Storage::MemoryRepeater`) and offers the Windows management plane on a Unix socket. There is no
web UI, no HTTP port, and nothing on the machine can decrypt a location.

```
streetcryptid-repeater status|claim|settings|watch ──unix socket──▶ streetcryptid-repeater run
                                                                    (a terminal, or systemd)
```

The Windows repeater needs a C# service to supervise its Rust host; on Linux systemd is the
supervisor, so `run` is both host and service: it speaks the service's side of the protocol to
every CLI that connects.

## Quick start

```sh
tar xzf streetcryptid-repeater-*-x86_64-linux.tar.gz
cd streetcryptid-repeater-*-linux
./streetcryptid-repeater run          # shows a claim QR in the terminal
```

Scan the QR with the owner's phone camera (or paste the link in streetCryptid, Settings >
Repeaters). Ctrl-C stops it. That is all a repeater needs; nothing is installed and nothing keeps
running.

To keep it running, opt in to the daemon:

```sh
./streetcryptid-repeater install                 # for you, while you are signed in
./streetcryptid-repeater install --linger        # for you, also after you sign out
sudo ./streetcryptid-repeater install --system   # for the machine, from boot
```

## Commands

| Command                                               | What it does                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------- |
| `run`                                                 | The repeater, in the foreground. Prints the claim QR at a terminal.       |
| `status [--json]`                                     | What it is doing: claim, people carried, items ready, traffic, settings.  |
| `claim [--once] [--link]`                             | The claim QR, renewed until a phone claims it (`--link`: the link alone). |
| `settings [--telemetry on/off] [--keep-awake on/off]` | Show or change this machine's choices.                                    |
| `watch`                                               | Every protocol line, as JSON, for scripts.                                |
| `install [--system]`                                  | Opt in to the systemd daemon (per user, or the machine's).                |
| `uninstall [--system]`                                | Stop and remove the daemon; the identity is kept.                         |

The management commands find the running repeater by themselves: your own first
(`$XDG_RUNTIME_DIR/streetcryptid-repeater/control.sock`), then the machine's
(`/run/streetcryptid-repeater/control.sock`). `--socket PATH` or `STREETCRYPTID_REPEATER_SOCKET`
names one.

## The management plane

The socket speaks the Windows repeater's line protocol (version 2, `repeater/host`): one JSON
object per line.

- On connecting, a client gets a `service` line (`starting`, `running`, `stopped`) and the latest
  `snapshot`, so it never waits for a first screen.
- Then a snapshot every two seconds and an `arrival` for each newly servable fix.
- The one command it takes is `settings` (`telemetry`, `keepAwake`), answered with a `result` to
  that client and a fresh snapshot to everyone. Anything else and the client is dropped, as the
  Windows service does.

The claim link travels over this socket, so it is never world-accessible: a person's socket is
0600 in their private runtime directory, the machine's is 0660 in a 0750 directory, open to root
and the `streetcryptid-repeater` group. The daemon checks its peer's credentials, and the CLI
checks the daemon's (it must run as you, root or the service account) before trusting a claim link.

## The system service

`sudo streetcryptid-repeater install --system`, the Windows service's equivalent:

- copies the binary to `/usr/local/lib/streetcryptid-repeater/` and runs it from there, never from
  wherever it was downloaded;
- creates the `streetcryptid-repeater` system account and runs as it, with no capabilities and a
  systemd sandbox (`ProtectSystem=strict`, `ProtectHome`, `NoNewPrivileges`, `PrivateDevices`, …),
  started at boot, restarted with backoff on failure (`Type=notify`: `systemctl start` returns once
  the node is up);
- keeps its state in `/var/lib/streetcryptid-repeater` (0700) and its socket in
  `/run/streetcryptid-repeater`;
- adds the person who ran sudo (or `--admin USER`) to the `streetcryptid-repeater` group, so after
  signing in again they manage it without sudo;
- **moves** that person's identity (`~/.local/state/streetcryptid/repeater`, or `--move-from DIR`)
  into the service and marks their directory `moved-to-service`, so a per-user `run` can never mint a
  second identity for a machine its owner already claimed. `--no-move` starts the service with its
  own. A per-user repeater that is still running must be stopped first.

The move copies into a staging directory, swaps it into place with the key last, and only then
deletes the source; an interrupted move is finished by running it again. Two different identities
are never merged or overwritten: it stops and says so.

`sudo streetcryptid-repeater uninstall --system` stops and removes the service and moves the
identity back to the person who ran sudo (`--move-to DIR` to choose, `--keep-state` to leave it in
`/var/lib`). The system account is left in place. Running `install` again updates the installed
binary and restarts it — the Windows app's **Update service**.

A per-user `install` writes `~/.config/systemd/user/streetcryptid-repeater.service`, runs a copy in
`~/.local/lib/streetcryptid-repeater/`, and keeps state where `run` does. Without systemd (a
container, an init-less box) there is nothing to install into: run `streetcryptid-repeater run`
under whatever supervises processes there; it stops cleanly on SIGTERM and keeps everything it
needs in `--state-dir`.

## Claiming and members

Claim links are single-use and rotate every 30 minutes. **Do not publish screenshots of an
unclaimed QR or copy its link into logs.** The daemon prints the QR only to an interactive
terminal; under systemd stdout is the journal, so it says to run `claim` instead. The owner phone
signs roster and policy changes and member removal; the machine shows who it carries and never
changes the roster on its own. To stop carrying someone, remove them on the phone (Settings →
Repeaters).

`status` reports people carried, encrypted items ready to forward (including control records),
missing content as "waiting for data", newly servable fixes received, and the endpoint's transport
counters (which include protocol overhead and reset when the daemon restarts). None of it is proof
that a friend decrypted a location.

## Storage and recovery

What the repeater carries lives in memory only, like every repeater. On disk are only what makes
it the same repeater: the private identity (`secret.key`, 0600), the signed roster, the namespace
grants and the settings. A restart comes back claimed and carrying the same people, holding nothing
until their phones sync again.

If the identity or settings are damaged, restore them rather than deleting them or claiming a
replacement: the daemon refuses to mint a new identity beside an existing roster. Preserve the
whole state directory when moving an installation by hand. Only one daemon can hold it.

## Diagnostics

Builds made with `SC_REPEATER_OTEL_ENDPOINT` set (release builds take it from the
`REPEATER_OTEL_ENDPOINT` repository variable) compile the OTLP exporter in; others have none. Even
then nothing is sent until someone runs `settings --telemetry on` (or `install --telemetry on`):
the choice is enforced per span, so turning it off stops export at once. What is sent is what the
Windows repeater sends — the stash's `repeater.*` spans and `repeater.host.start` / `.pulse` /
`.stop` with `host.platform = linux` — keyed by the short endpoint id. Never a location.

## Power

`settings --keep-awake on` holds a logind sleep inhibitor (`systemd-inhibit --what=sleep`)
while the machine is on mains power and releases it on battery. A machine without a battery counts
as mains. logind lets an account hold one only from an active session, so `install --system` adds
a polkit rule (`/etc/polkit-1/rules.d/50-streetcryptid-repeater.rules`) granting the service's
account that inhibitor and nothing else; `uninstall --system` removes it. Where the
inhibitor is still refused (polkit older than 0.106, a lingering per-user daemon, no logind at
all), `status` says the setting is on but not holding, and the pulse reports the same.

## Build and test

Rust 1.97.0 (the repository's `rust-toolchain.toml`) and `protoc`. From the repository root, on
Linux or WSL:

```sh
just linux::test      # the host and CLI unit tests
just linux::build     # target/desktop-release/streetcryptid-repeater
just linux::smoke     # run the built daemon and manage it, unprivileged
```

`scripts/test-service.sh` installs the real system service, moves an identity in and out and
removes it; CI runs it on its disposable runners. Run it only on a machine you do not care about (a
throwaway VM or WSL distribution).

Release binaries are built on Ubuntu 22.04 and run on glibc 2.35 or newer.
