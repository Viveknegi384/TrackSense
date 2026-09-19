# TrackSense free deployment

This setup uses:

- Render Static Site for the Vite frontend
- Render Free Web Service for the Node.js Socket.IO gateway
- Render Free Web Service for FastAPI and the embedded simulator
- Neon Postgres for the database

Render's free web services sleep after inactivity, so the live simulator runs
only while the dashboard is being used. Render's free Postgres is not used
because it expires after 30 days.

## 1. Create the database

Create a free Neon project and copy its pooled PostgreSQL connection string.
It should look like:

```text
postgresql://user:password@host/dbname?sslmode=require
```

Run the schema and seed files from the repository root. In Neon SQL Editor,
paste and run them in this order:

1. `database/01_schema.sql`
2. `database/02_seed.sql`

The simulator creates the initial live telemetry rows on its first reset. The
Node gateway also exposes `POST /api/reset-demo` for this purpose.

## 2. Deploy the services

1. Push this repository to GitHub.
2. In Render, choose **New > Blueprint** and select the repository.
3. Select `render.yaml` and create all three services.
4. Choose the same Render region for both backend services.

Set these values in the Render dashboard after the services are created:

### `tracksense-python`

```text
DATABASE_URL=<Neon pooled connection string>
GROQ_API_KEY=<Groq API key>
ENABLE_SIMULATOR=true
```

### `tracksense-node`

```text
DATABASE_URL=<same Neon pooled connection string>
PYTHON_API_URL=https://tracksense-python.onrender.com
CORS_ORIGIN=https://tracksense-frontend.onrender.com
```

Replace the hostnames above if Render assigns different service names.

### `tracksense-frontend`

```text
VITE_NODE_URL=https://tracksense-node.onrender.com
VITE_PYTHON_URL=https://tracksense-python.onrender.com
```

Because Vite variables are embedded during the build, redeploy the frontend
after changing either `VITE_*` value.

## 3. Verify the deployment

Open these URLs in a browser:

```text
https://tracksense-python.onrender.com/health
https://tracksense-node.onrender.com/health
https://tracksense-frontend.onrender.com
```

The frontend should show a Live connection after the Node service wakes up.
If the map is empty, call the reset endpoint once:

```powershell
Invoke-RestMethod -Method Post `
  -Uri https://tracksense-node.onrender.com/api/reset-demo
```

## Free-tier caveats

- Render free services sleep after 15 minutes without inbound traffic and can
  take about a minute to wake up.
- Render free web services have limited monthly instance hours.
- The embedded simulator is intentionally enabled only on the FastAPI service;
  do not also run `generator.py` as a second simulator in production.
- The AI Copilot requires a valid `GROQ_API_KEY`; the dashboard and ETA APIs
  work without asking Copilot questions.