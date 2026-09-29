# Craftline — Skilled Trade Knowledge Platform

Eight connected pages: Login, Knowledge Feed, Post Details, Create Tutorial, User Dashboard, Trade Category, Admin Panel, and an interactive User Flow page. Members can now rate published guides from one to five stars; moderators can review aggregate ratings and download a CSV usage report from the Admin Panel. Text assets use gzip compression and versioned script caching, and feed responses defer guide image data until a detail page is opened.

## Technology choices

- Frontend: HTML5, CSS3, and JavaScript.
- Backend: Node.js 24 and Express 5.
- Database: PostgreSQL in production; SQLite is only the local development fallback.
- Media: Cloudinary for production guide images. Local development can use database-backed images.
- Deployment: Render web service and managed PostgreSQL, configured together in `render.yaml`.

See [PRD.md](PRD.md) for the full product requirements, user flows, acceptance criteria, and deployment notes.

## Run locally

Requires Node.js 24 or newer. Express handles the Node.js HTTP application, SQLite supports local development, and the `pg` client connects to shared PostgreSQL deployments.

1. Copy `.env.example` to `.env` and set a unique moderator email and password (at least 16 characters).
2. Run `npm install` to install Express and the PostgreSQL client.
3. From this folder, run `npm start`.
4. Open `http://localhost:3000`.

Run `npm test` for isolated route, security, feature, compression, and persistence smoke checks. Run `npm run benchmark` for a local two-worker baseline. After deployment, set `BENCHMARK_BASE_URL` to the public site URL and run `npm run benchmark:host` for read-only timing of the health check, feed API, and compressed script on that host. Choose a load test matching the selected hosting plan before claiming production capacity.

The app creates `data/craftline.sqlite` on first run, seeds realistic trade guides, and provisions the moderator account from the environment values. SQLite is for local, single-host use. Set `WEB_CONCURRENCY` to 2–8 to run multiple Node.js workers on one server; workers share SQLite sessions, content, and login rate limits. Keep `.env` and the database private.

## Cloud image storage

In local development, guide images can be stored in SQLite. Production requires Cloudinary: set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` in the hosting provider's private environment settings. The server makes signed uploads and stores the resulting secure image URL; the API secret stays on the server. Do not commit real Cloudinary credentials.

## Security and storage

Passwords are stored as PBKDF2-SHA256 hashes with per-account salts. Session tokens are random, stored hashed in the configured database, and sent through an HttpOnly, SameSite cookie. The server validates permissions for contributor and moderator endpoints, applies shared database login rate limits, rejects cross-origin write requests, and validates guide content and images. SQLite WAL mode and indexed lookups support local single-host work. Set `DATABASE_URL` to PostgreSQL to use shared storage across application hosts; the server creates its tables and indexes on startup. `WEB_CONCURRENCY` controls workers per host, and a bounded `PG_POOL_BUDGET` is divided between workers to control the total local connection count. Set `PGSSLMODE=require` when your provider requires verified TLS. Set `TRUST_PROXY=true` only behind a trusted proxy. Production startup requires PostgreSQL so instances cannot silently use separate local databases.

### Move local content to PostgreSQL

Create the PostgreSQL database and configure its connection string as `DATABASE_URL` in `.env`. Start Craftline once so it creates the PostgreSQL schema, then stop it. Run `npm run migrate:postgres` to copy categories, guides, comments, users, ratings, votes, and bookmarks from the local SQLite file. The importer keeps the existing PostgreSQL moderator account on email conflicts and remaps related author/user references. Sessions and temporary login limits are not copied, so users sign in again after migration. Back up both databases first.

The included `.env.example` is safe to share; never publish `.env`, a production database, or real credentials. Production must use HTTPS so the session cookie's Secure attribute is active.

## Deploy on Render

`render.yaml` configures an Express 5 / Node 24 web service and a private managed PostgreSQL database in the same region. Both use Render's Free compute plan. The blueprint connects `DATABASE_URL` automatically and prompts for moderator credentials and the three Cloudinary values as private secrets. Cloudinary credentials are required for production image uploads. A Render deployment must be connected to a Git repository first. After deployment, set `BENCHMARK_BASE_URL` locally to the public URL and run `npm run benchmark:host` for read-only timings. This benchmark measures that host; it does not establish capacity under realistic concurrent user load.

Free-tier limits matter: Render's free web service can run only one instance, spins down after 15 minutes idle, and may take about a minute to wake. Free Render Postgres is limited to 1 GB, has no backups, and expires after 30 days. The app is built with PostgreSQL shared storage so it can use multiple app instances, but horizontal scaling requires a paid web-service plan; the free deployment is a learning/demo deployment, not production capacity.

The hosting account and repository connection are user-owned steps; this workspace does not have access to publish to a hosting account.
