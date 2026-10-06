# Field soak: a real iPhone, a simulated life

A long-running test on **real hardware**. An iPhone plugged into this Mac in Developer Mode runs
its own StreetCryptid account: **Wayward Kappa**, Claude's cryptid, who lives in Kyoto and is
friends with the people in a private Discord channel. The Mac drives the phone's GPS through walks
with real streets, human pacing and real stops. Every two hours a headless Sonnet tick:

- grades what the app published against where the phone actually was
- looks at the map the way a friend would
- plans the next outings and keeps a journal
- talks to the channel

A message in the channel wakes it sooner.

This covers what the simulator matrix structurally can't: the real iOS background budget, a real
`CLLocationManager` and BGTask scheduling, MetricKit, and a real phone-to-phone path to friends
who are out living their lives. What it can't cover is in the skill's "Known rig limits" section
(USB power, Wi-Fi only, no physical motion) and in `scripts/e2e/PHYSICAL-DEVICE-CHECKLIST.md`.

## Moving parts

| piece                                | what it does                                                                                                                                                                                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `walker.py` (LaunchAgent, KeepAlive) | Owns the phone's userspace tunnel (no root) and sets a location at 1 Hz. Writes `truth.jsonl`. Its control port (127.0.0.1:47811) does screenshots, accessibility reads, WebDriverAgent taps and typing, network conditions and app foreground/background. |
| `plan_outing.py`                     | Geocodes places (Nominatim) and routes them on real streets (FOSSGIS OSRM, foot and car), then bakes in pace, crossings and dwell jitter and queues the outing.                                                                                            |
| `check.py`                           | Grades Tempo against truth: moving gaps, parked latency, live-again latency, what the partner received, `peer.contact`, the latest `device.health`. Also does Discord (webhook and bot).                                                                   |
| `tick.sh` (LaunchAgent, every 2 h)   | `claude -p --model sonnet` following `.claude/skills/field-soak/SKILL.md`, with a tool allowlist that can only run `fs`, read, and write the state dir. `tick.sh chat` is the short variant.                                                               |
| `listen.py` (LaunchAgent, KeepAlive) | Polls the Discord channel every 20 s. A human message shows "typing…" and starts `tick.sh chat`, at most once per message and once per 2 min.                                                                                                              |
| `build-install.sh`                   | Builds the current checkout as a signed Release and installs it on the phone in place. `--rust` rebuilds the XCFramework first.                                                                                                                            |
| `fs`                                 | The one command-line entry point for all of the above.                                                                                                                                                                                                     |

**Configuration** is split three ways, and none of it is committed:

- `scripts/field-soak/.env` (gitignored; copy `.env.example`): the Grafana URL, the Apple Team ID
  and the phone's UDID.
- **Secrets**, each a `chmod 600` file in `~/.config/streetcryptid/`: `grafana-token`,
  `field-soak-discord-webhook` and `field-soak-discord-bot-token`.
- **Runtime state** in `~/.local/state/streetcryptid-field/`:
  - `config.json`: telemetry instance ids, the Discord channel, the home position, the persona
  - the queue, truth, events, verdicts and screenshots
  - the tick's own notes: `journal.md`, `places.md`, `june.md`, `people.md`, `alerts.json`

The venv and the WebDriverAgent build live in `~/.local/share/streetcryptid-field/`.

**Why the walker is a daemon.** On iOS 17+ a simulated location lasts only as long as the DVT
channel that set it: close it and the phone snaps back to its real position. pymobiledevice3's
userspace tunnel is also a process-global stack that can't be re-established inside the same
process. So the walker exits on any device error and launchd restarts it, and since outings are
laid out on absolute time, a restart resumes at the right spot.

## Setup (once)

1. Plug the phone in, trust the Mac, and turn on Developer Mode (`pymobiledevice3 amfi
reveal-developer-mode` makes the toggle appear), then run `pymobiledevice3 mounter auto-mount`.
   Set Auto-Lock to **Never**: the rig sends the app to the background itself between looks.
2. `cp scripts/field-soak/.env.example scripts/field-soak/.env` and fill it in. Put the Grafana
   token in its secrets file.
3. `scripts/field-soak/install.sh walker`. The phone now sits "at home" in Kyoto.
4. `scripts/field-soak/build-install.sh` (add `--rust` on a fresh checkout or after Rust changes).
   The repo's `.env.local` must carry the `EXPO_PUBLIC_*` telemetry variables.
5. WebDriverAgent, which gives the rig the ability to type and tap: build appium/WebDriverAgent's
   `WebDriverAgentRunner` scheme for the phone with `build-for-testing`, using
   `DEVELOPMENT_TEAM=<team>` and `PRODUCT_BUNDLE_IDENTIFIER=com.unrealjune.WebDriverAgentRunner`.
   Then `devicectl device install app` the resulting `WebDriverAgentRunner-Runner.app`. The walker
   starts it on demand.
6. Onboard and pair. `fs ui` / `fs tap` / `fs type` drive the screens; the skill describes the
   pairing flow. Use `fs discover` to find the telemetry ids, and set `se2_instance_id` (the
   phone) and `partner_instance_id` (a friend) in `config.json`.
7. Discord. A webhook gives send-only alerts. A bot (with the Message Content intent and the
   View Channel / Send Messages / Read Message History permissions) lets the rig read and answer.
   Set `discord_channel_id` in `config.json`.
8. `scripts/field-soak/install.sh tick` and `install.sh listen` (set `TICK_HOURS=1` for a denser
   cadence).

The LaunchAgents point at whichever checkout ran `install.sh`, so run it from a checkout that will
stay put.

## Day to day

```
fs status ; fs events 6 ; fs check --hours 6 ; fs journal-tail ; fs inbox --peek
tail -f ~/.local/state/streetcryptid-field/walker.log
ls -t ~/.local/state/streetcryptid-field/ticks | head   # what each Sonnet tick did
scripts/field-soak/install.sh uninstall                 # stop everything (state is kept)
```

To soak a branch, check it out and run `build-install.sh`. The account and pairings survive an
in-place install.
