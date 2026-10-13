# OGFN Server Emulator

A private backend for old Fortnite builds. It stands in for Epic's online services so you and your friends can log in, use your locker, buy from a custom item shop, add friends, party up, and queue into your own game servers.

> Not affiliated with Epic Games. This project ships no game files or Epic assets. You need your own copy of an old build. Running private servers goes against Epic's terms, so keep it private and use it at your own risk.

## What it does

| Part | What you get |
|---|---|
| Accounts & login | Sign-up page, Epic-style OAuth (`password`, `exchange_code`, `refresh_token`, `client_credentials`), hashed passwords, hashed tokens, bans, optional invite code |
| Database | SQLite (built into Node, nothing to install). Stores accounts, sessions, profiles, friends, settings files |
| Profiles (MCP) | Locker for both old (`EquipBattleRoyaleCustomization`) and new (`SetCosmeticLockerSlot`) seasons, styles, banners, favorites, V-Bucks, shop purchases |
| Item shop | Set it in `shop.json`. Featured + Daily sections, resets at midnight UTC |
| Season handling | Reads the build from the client and shows the right lobby, calendar and background |
| Friends | Old and new friends APIs, requests, blocking, search |
| XMPP | Online status, whispers, party chat rooms, live friend-request popups |
| Matchmaking | Signed tickets, the real queue states, sends players to game servers by region/playlist. Private servers with a custom matchmaking key |
| Cloud storage | Hotfix `.ini` files and each player's `ClientSettings.Sav` |
| Admin | CLI tool and an optional admin REST API |

Tested target: roughly Seasons 1 to 10. Later seasons may need more endpoints.

## Quick start

You need **Node.js 22.13 or newer**.

```bash
npm install
npm start
```

- Backend: `http://127.0.0.1:3551`
- Sign-up page: open `http://127.0.0.1:3551` in a browser
- XMPP: port `80` (Fortnite expects this). If port 80 is blocked, the server says so and falls back to port 3551.

Or with Docker:

```bash
docker compose up -d
```

## Connecting the game

The game has to send its Epic traffic to this server instead of Epic's. Two things are needed:

1. **Redirect traffic.** The simplest way is Fiddler Classic with [`docs/FiddlerScript.js`](docs/FiddlerScript.js). Community OGFN launchers and redirect DLLs also work; point them at `127.0.0.1:3551`.
2. **Log in.** Start the build with your login on the command line:

   ```
   -AUTH_LOGIN=you@email.com -AUTH_PASSWORD=yourpassword -AUTH_TYPE=epic
   ```

   Or, to keep your password off the command line, get a one-time code from the "Get login code" tab on the sign-up page (or `POST /api/launcher/exchange`) and use:

   ```
   -AUTH_TYPE=exchangecode -AUTH_PASSWORD=<code>
   ```

Playing a match also needs a game server running the same build. This project handles the matchmaking side; add your server's address in `config.json`:

```json
"matchmaking": {
  "gameServers": [
    { "ip": "127.0.0.1", "port": 7777, "regions": ["NAE"], "playlists": ["playlist_defaultsolo"] },
    { "ip": "127.0.0.1", "port": 7778, "customKey": "friends123" }
  ]
}
```

A server with a `customKey` only takes players who enter that key in the game's custom matchmaking box. Empty `regions` or `playlists` means "any". With no matching server, players just wait in the queue.

## Configuration

Edit `config.json`, or put your changes in `config.local.json` (git-ignored). Main settings:

| Setting | Default | What it does |
|---|---|---|
| `server.port` | `3551` | Backend port |
| `server.publicHost` | `127.0.0.1` | The IP players use to reach you. Used for XMPP and matchmaking URLs |
| `xmpp.port` | `80` | XMPP port written into `DefaultEngine.ini` |
| `registration.enabled` | `true` | Turn sign-ups on or off |
| `registration.inviteCode` | `""` | If set, sign-up requires this code |
| `game.startingVbucks` | `1000` | V-Bucks for new accounts |
| `game.giveAllCosmetics` | `false` | Give everyone every cosmetic (list downloaded once from `game.cosmeticsSource` and cached in `data/`) |
| `game.news` | welcome message | Lobby news |
| `admin.apiKey` | `""` | Turns on the admin API when set |

Environment variables override the file: `PORT`, `PUBLIC_HOST`, `XMPP_PORT`, `DB_PATH`, `DATA_DIR`, `ADMIN_KEY`, `INVITE_CODE`.

Hotfix files live in `cloudstorage/`. `{{XMPP_HOST}}` and `{{XMPP_PORT}}` get filled in for you.

## Admin

Command line (works on the database directly, server can be running):

```bash
npm run cli -- create you@email.com YourName yourpassword
npm run cli -- vbucks YourName 13500
npm run cli -- grant YourName AthenaCharacter:CID_028_Athena_Commando_F
npm run cli -- ban SomePlayer
npm run cli -- help
```

Admin API (needs `admin.apiKey`, sent as `Authorization: Bearer <key>`):

| Method | Path | Body |
|---|---|---|
| GET | `/admin/api/accounts` | |
| GET | `/admin/api/accounts/:nameOrId` | |
| POST | `/admin/api/accounts/:nameOrId/ban` / `unban` | |
| POST | `/admin/api/accounts/:nameOrId/vbucks` | `{ "amount": 5000 }` |
| POST | `/admin/api/accounts/:nameOrId/items` | `{ "items": ["AthenaDance:EID_Floss"] }` |
| DELETE | `/admin/api/accounts/:nameOrId` | |
| POST | `/admin/api/shop/reload` | reloads `shop.json` |
| GET / POST / DELETE | `/admin/api/gameservers[/:index]` | add or remove game servers while running |

## Project layout

```
src/
  index.js            start-up
  server.js           HTTP + websocket servers, wires services together
  app.js              Express app, error format
  config.js           config loading
  db/database.js      SQLite schema
  services/           accounts, tokens, profiles, friends, shop, matchmaking, cosmetics
  routes/             one file per Epic service (account, mcp, game, friends, ...)
  xmpp/server.js      XMPP over websocket
  matchmaker/         matchmaking websocket
public/               sign-up page
cloudstorage/         hotfix .ini files
scripts/cli.js        admin CLI
test/                 tests (npm test)
```

## Development

```bash
npm run dev    # restarts on file changes
npm test       # runs the test suite
```

Set `server.logRequests` to `true` to log every request. Requests the server doesn't know are always logged, which is the quickest way to find what a new build needs.
