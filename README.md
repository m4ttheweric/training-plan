# Training Plan

A local running-plan dashboard for your own training. Write a plan as JSON, see today's workout and upcoming weeks, and optionally compare it with your Strava activities. The code is Bun, SQLite, TypeScript, and plain browser JavaScript.

This is a personal tool you can clone and adapt. Each checkout has its own database and one runner's Strava connection. There are no hosted accounts or subscription service. Plan viewing works without Strava, Apple Health, or an AI account.

## Installation

### Quickstart

Install [Bun](https://bun.sh/) (tested with 1.4.2), then:

```sh
git clone https://github.com/m4ttheweric/training-plan.git
cd training-plan
bun install --frozen-lockfile
cp .env.example .env
bun run start
```

Open **http://localhost:8081**. The app creates `data/training.db` automatically. `bun run dev` enables hot reload. On macOS/Linux, `./start-server.sh` also works from any working directory.

The included [10K plan](plans/10k-oct-2026.json) is the author's July–October 2026 plan. Its paces, lifting routine, and injury notes belong to that runner. It remains as a reference; an expired plan shows **Plan complete**. Create your own plan before using the schedule for your training.

## Create your own plan

### With a coding agent

The repository includes [create-training-plan](.agents/skills/create-training-plan/SKILL.md). Ask your agent to read that file and create a plan here. It gathers your training constraints, writes compatible JSON, checks the calendar and mileage, and runs the validator.

Example request:

> Read `.agents/skills/create-training-plan/SKILL.md` and create a four-week maintenance plan. I run 9 miles per week, can run Monday, Wednesday, and Saturday, and want Sunday off. Start November 2, 2026. No race or strength work. Preserve the existing plan and tell me how to activate the new one.

The skill ships with the clone; no global skill installation is required when you give the agent this path.

### By hand

Copy the [neutral example](examples/maintenance-example.json) into `plans/`:

```sh
cp examples/maintenance-example.json plans/maintenance-example.json
```

Edit its Monday `startDate`, workouts, mileage, phases, and descriptions. For a different filename, change `id` to match it. The [JSON schema](schemas/training-plan.schema.json) supports editor validation through the `$schema` field. The [runtime validator](src/plan-schema.ts) also checks relationships between dates and weeks.

The format requires:

- Seven days per week, ordered Monday through Sunday; a Monday `startDate`.
- Consecutive week numbers from 1; each week assigned to exactly one phase.
- Day types `run`, `long`, `lift`, `rest`, or `race`. Runs require positive `miles`.
- Miles for every distance, including race distance. Convert kilometers before saving.
- For race plans, matching race metadata and a race day on the specified date. Omit `race` for maintenance plans.
- Required `glossary`, `rules`, and `callout`, which may be empty.

Validate before using it:

```sh
bun run validate:plans plans/maintenance-example.json
# Or validate every file in plans/:
bun run validate:plans
```

Successful validation prints `Valid: <path>` and exits with code 0:

```console
$ bun run validate:plans plans/maintenance-example.json
Valid: plans/maintenance-example.json
```

Set `PLAN_ID=maintenance-example` in `.env` and restart the server. This selects that plan consistently for Today, Journal, Plan, recovery, and run analysis. Preserve the other settings in `.env` when changing plans. Without `PLAN_ID`, the app prefers the most recently started current plan, then the latest past plan, then the earliest upcoming plan.

## Connect Strava (optional)

1. Create your own app at [Strava's API settings](https://www.strava.com/settings/api). Set its **Authorization Callback Domain** to `localhost`.
2. Put its client ID and client secret in `.env` as `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET`.
3. Restart the app, open **Journal**, and choose **Connect with Strava**. Authorize access, then choose **Sync now**.

The default callback is `http://localhost:8081/auth/strava/callback`. Changing `PORT` updates the default callback automatically. If you use a local proxy, set `BASE_URL` to its origin and configure the corresponding Strava callback domain. See [Strava's OAuth documentation](https://developers.strava.com/docs/authentication/).

The browser flow stores and refreshes tokens locally. Existing access/refresh tokens are optional alternatives; they are not required for setup.

Sync imports activity history, mile splits, and historical weather. It runs in the background; automatic syncs are throttled. Completion matching accepts workouts moved by one day. There is no manual workout-completion button; completed workouts come from Strava. Sync errors appear in Journal.

## Run analysis (optional)

Install and authenticate [Claude Code](https://code.claude.com/docs/en/overview), confirm `claude` is on your server's PATH, and set:

```dotenv
FEEDBACK_ENABLED=true
```

Restart, open a run in Journal, and choose **Analyze this run**. No external analysis skill is needed. The app sends the selected run, splits, plan, recent runs, and available daily health metrics to your configured Claude account. It requests an Opus analysis with tools disabled, validates the response, and stores the narrative locally. Usage follows your Claude subscription or API account.

By default it uses Claude's current authenticated account. If you already use `cswap`, set `FEEDBACK_CLAUDE_ACCOUNT` to the email of the account you want; then both `claude` and `cswap` must be on PATH. No author's account is assumed. The [Claude CLI reference](https://code.claude.com/docs/en/cli-reference) describes the command options.

Analysis is disabled by default. The UI reports missing setup instead of offering an action that cannot run. A failed CLI call or invalid response keeps previous feedback intact. Re-analysis requires confirmation; only one analysis runs at a time, with a five-minute timeout.

## Health metrics (optional)

The recovery view can use Health Auto Export JSON containing daily aggregated metrics. It is independent of Strava and works without run analysis. Import an export file from the same machine:

```sh
curl -X POST http://localhost:8081/api/health \
  -H 'Content-Type: application/json' \
  --data-binary @health-export.json
```

Use the format `{ "data": { "metrics": [...] } }`; the parser supports daily quantity metrics, sleep stages, and heart-rate summaries. Without sleep data, the app omits unavailable recovery measurements. Importing writes to the local SQLite database.

## Configuration and local data

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8081` | Server port |
| `HOST` | `127.0.0.1` | Bind address; loopback keeps the app local |
| `BASE_URL` | `http://localhost:<PORT>` | Public origin used for the Strava OAuth callback |
| `PLAN_ID` | Automatic selection | Plan filename without `.json` |
| `DATA_DIR` | Repository `data/` | Database directory; created on startup |
| `FEEDBACK_ENABLED` | `false` | Enable optional Claude run analysis |
| `FEEDBACK_CLAUDE_ACCOUNT` | Claude's current account | Optional explicit `cswap` account email |

This app has no application login and is intended for local, single-user use. Keep the loopback default for ordinary use. `portless.json` and `mattstack.deck.json` are optional local development integrations; neither is required to run the app.

Back up `data/` when the server is stopped to retain activities, tokens, imported health metrics, and analyses. `.env`, environment variants, database files, dependencies, logs, and local agent working files are ignored. Share plans and code, rather than your database or credentials. The app reads dates in the server's local timezone, so run it in your own timezone.

## Development and contributing

```sh
bun run dev
bun run typecheck
bun run validate:plans
bun run test
```

`bun run test` validates plans, typechecks the server, and runs the test suite. Server integration tests use a temporary database and fake Claude executable; they do not connect to Strava or AI services. GitHub Actions runs the checks on Linux and macOS.

Source lives in `src/`, browser files in `public/`, and plan JSON in `plans/`. To change the format, update the schema, TypeScript contract and cross-field validator together, then update the skill and example. New plans should pass validation and preserve existing plans unless replacing one intentionally. Keep personal data and credentials out of contributions.

## License

No license has been selected yet.
