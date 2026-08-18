# Questboard family server

Questboard gamifies daily, weekly and monthly household tasks with XP, levels, completion streaks, unlockable rewards and family leaderboards. This version stores household data on a small Node server so phones, tablets and computers share the same users, quests, rewards, completions and scores.

## Quick start with Docker Compose

From this directory, run:

```bash
docker compose up -d --build
```

Open Questboard on the Docker host at:

```text
http://localhost:4173
```

From another device on the same home network, replace `localhost` with the Docker host's LAN IP address, for example:

```text
http://192.168.1.50:4173
```

To use a different host port:

```bash
QUESTBOARD_PORT=8080 docker compose up -d --build
```

## First login and default PINs

A fresh installation creates a dedicated administrator profile:

```text
Profile: Parent
Default PIN: 1234
```

Switch to **Parent**, enter `1234`, open **Parent area**, edit the Parent profile and replace the default PIN immediately.

The sample child profiles use `0000`. When an existing pre-PIN Questboard installation is upgraded, its existing child profiles are also assigned `0000`; their users, quests and XP history are retained. Change each migrated PIN from **Parent area → Players → Edit**.

New child profiles require a 4-to-8-digit PIN when they are created. Only an authenticated admin can add users or change any account PIN.

## PIN and session behaviour

- Switching to a different profile always requires that profile's PIN.
- The Parent area is available only while an admin profile is unlocked.
- Child sessions can complete only quests assigned to that child.
- Child sessions cannot edit users, quests, time settings, history or PINs.
- The header's lock button ends the current profile session.
- Sessions are held in server memory. Restarting the container keeps all data and PINs but requires each device to enter a PIN again.
- Five failed PIN attempts trigger a short per-device lockout.
- PINs are salted and hashed with `scrypt`; plaintext PINs are never written to the data file or included in exports.

## Streaks and rewards

- Every child has a **daily streak** showing how many consecutive days all of their active daily quests were completed.
- The home-screen Daily Streak tile uses a three-state flame to show today's progress: grey before any daily quest is completed, yellow while some are complete, and a bright flame once all active daily quests are finished. The tile also shows how many daily quests remain, or confirms when the streak is secured.
- The Standings section uses the same three-state flame beside each player's streak, so today's streak progress is visible across the family leaderboard.
- Administrators can enable **Streak freeze** from **Parent area → App Settings**. It is off by default and applies to every player.
- While Streak freeze is active, frozen calendar days neither increase nor break streaks. The streak count is held steady, and the usual flame is replaced by a **❄️ snowflake** on the home screen, Standings and Parent player summaries.
- Turning Streak freeze off resumes normal tracking. Days already covered by the freeze remain protected, so a holiday or exceptional day cannot break the streak later.
- Finishing all daily quests on a normal day extends the streak. An unfinished current day does not erase a streak earned through yesterday; the streak breaks only after a full missed, non-frozen day.
- A daily quest starts affecting streaks from the day it is created, so adding a new quest does not retroactively break earlier days. Paused daily quests are not required.
- Streaks use the configured household timezone and appear beside the front-page XP totals and on every leaderboard row.
- Rewards are shared across the household and unlock independently for each child using **lifetime XP**.
- The admin can create, edit, pause and delete rewards from **Parent area → Reward editor**. Each reward has an icon, title, optional description and XP threshold.
- Fresh installations include three sample rewards. Existing installations keep their data and start with an empty reward catalogue unless rewards were already present in an imported backup.

## Run with plain Docker

```bash
docker build -t questboard .
docker run -d \
  --name questboard \
  --restart unless-stopped \
  -p 4173:4173 \
  -v "${PWD}/data:/data" \
  questboard
```

## Persistent storage

The container writes a single atomic JSON data file to:

```text
/data/questboard.json
```

`compose.yaml` bind-mounts `${PWD}/data` on the host to `/data` in the container. The live database is therefore kept in `./data/questboard.json` alongside the installation and survives container rebuilds or recreation.

Useful commands:

```bash
# View logs
docker compose logs -f

# Restart the app
docker compose restart

# Stop it without deleting data
docker compose down

# Rebuild after an update
docker compose up -d --build
```

Do not delete the local `./data` directory during upgrades; it contains the live `questboard.json` database and PIN hashes.

## Upgrading the previous server version

Replace the application files and rebuild the container while keeping the existing `./data` directory. If you are moving from an older Questboard release that used the Docker named volume `questboard-data`, copy `/data/questboard.json` from that volume into `./data/questboard.json` before starting this version. The bind mount does not migrate named-volume contents automatically.

```bash
docker compose up -d --build
```

On first start, Questboard automatically:

1. Retains existing users, quests, completions and XP history.
2. Upgrades the shared data schema to support streak calculations, streak-freeze periods and rewards.
3. Adds a dedicated **Parent** admin profile if one does not exist.
4. Assigns the Parent default PIN `1234`.
5. Assigns existing child profiles the migration PIN `0000`.
6. Stores only salted PIN hashes.

## Backups and migration

The Parent area includes **Export data** and **Import data** controls. Exporting produces a portable JSON backup containing players, roles, quests, rewards and XP history. PINs are deliberately excluded.

To migrate from the earlier browser-only prototype:

1. Open the old prototype in the browser that contains the data.
2. Use **Parent area → Export data**.
3. Open this server version and unlock the Parent profile.
4. Use **Parent area → Import data**.
5. Set a new PIN for each imported profile.

For matching users already present on this server, importing a backup preserves their current PINs. Newly imported users initially receive `0000` until the admin changes them. Restoring the sample data does not reset existing PINs.

## Synchronisation behaviour

- The server is the source of truth for users, tasks, rewards, timezone, streak settings, completion history and PIN hashes.
- Each device keeps its own authenticated profile session.
- Devices poll for updates every four seconds and immediately save authorised changes.
- Admin saves use revision checks and a three-way merge, preserving near-simultaneous changes from different devices.
- Task completions use a dedicated server endpoint, preventing a child from awarding XP to another account.
- A local browser cache can display the latest known board during a brief outage, but unlocking profiles and changing data requires the server.

Task reset boundaries use the configured household IANA timezone:

- Daily quests become available at local midnight. Their cards show a countdown rounded to the nearest 30 minutes.
- Weekly quests become available at local midnight on Monday. Their cards show whole days remaining, switching to days and hours in the final 48 hours.
- Monthly quests become available at local midnight on the first day of the month. Their cards use the same day/hour countdown rules as weekly quests.

Countdowns refresh approximately every 30 minutes and whenever the page is opened or synchronised. Completion history is retained; availability and streaks are calculated from the stored history rather than deleting records at reset time.

## Run without Docker

Node.js 22 or newer is required.

```bash
npm start
```

By default, data is stored in `./data/questboard.json`. Override the location or port with environment variables:

```bash
DATA_DIR=/path/to/data PORT=4173 npm start
```

Run the dependency-free syntax and API tests with:

```bash
npm run check
npm test
```

## Security note

PINs protect household profiles and administrative functions, but this remains a small self-hosted family application rather than an internet-facing identity system. It does not terminate HTTPS. Keep it on a trusted home network, or place it behind an authenticated HTTPS reverse proxy before exposing it beyond that network.


## Multiple administrators

Any player profile can be granted the **Administrator** role from **Parent area → Players → Edit**. All administrators can open the Parent area and manage players, PINs, quests, rewards, settings, and XP corrections. Questboard prevents the final administrator from being demoted or deleted.

The Parent area is divided into sub-tabs for Players, App Settings, Quest Editor, Reward Editor, and Recent XP Activity.
