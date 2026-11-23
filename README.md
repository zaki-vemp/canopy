# Canopy

Peer-blind, interest-matched **25-member** democratic rooms (`YES > NO` voting on every pod change) + **Canopy Pro** custom private/publicized admin groups, with Slack-style threads, polls, voice notes, pod invite links, `FULLTEXT` search, and Discord-style WebRTC voice lounges.

- **Database (`db/`)**: MySQL 8.0 / PlanetScale Vitess (`utf8mb4_0900_ai_ci`, narrow `BIGINT UNSIGNED` PKs, `BINARY(16)` UUIDv7 public IDs, composite keyset cursor indexes, `FULLTEXT` search, `vschema.json`).
- **Backend (`backend/`)**: Spring Boot 3.4 on Java 21 (auth, JWT security, private account demographics, `FREE`/`PREMIUM` plan tier, attachments) + Kotlin 2.x (multi-pod blind matching with `Compact (10)` / `Standard (25)` / `Club (50)` capacities, `YES > NO` Democratic Pod Governance engine across 8 action kinds, Canopy Pro owned `ADMIN` groups & Publicized Directory, Pod Invite Links, rich chat, native WebSocket hub & WebRTC signaling) via explicit `JdbcClient` SQL.
- **Web Frontend (`frontend/`)**: Mobile-first Next.js 15 App Router, React 19, Jotai + TanStack Query/Virtual (zero Redux), WebAudio + WebRTC P2P Opus mesh, inline & drawer Pod Vote cards, Publicized Groups directory, Pro Custom Group creator & Admin panel, Pod Invite Modal, and `tasteskill 2.5` (`white-mint-tiles`, `Familjen Grotesk` + `IBM Plex Mono`, zero violet).
- **Mobile App (`mobile/`)**: React Native + Expo SDK 52 (TypeScript, zero Redux — Jotai atoms + TanStack Query + native WebSocket + `expo-av` voice notes & voice lounges) sharing 1-for-1 DTO parity across 25-seat democratic voting, Pro custom/publicized groups, and pod invite links.

## Privacy Boundary

`users` stores `full_name`, `email`, `gender`, and `nationality_code` **strictly** for account authentication and `/api/auth/me`. Matching queries never inspect gender or nationality, and every pod mints an unlinkable room-scoped animal alias (e.g. `Cobalt Fox`) and SHA-256 peer ID (`p_<12hex>`). Zero PII or internal user IDs ever enter pod, channel, message, reaction, poll, or WebSocket payloads.

---

## Run Locally

### Prerequisites
- Docker (for MySQL 8.0)
- JDK 21 + Maven 3.9+
- Node.js 22+ & npm

### 1. Start MySQL 8.0 (`127.0.0.1:3308`)

```bash
docker run -d \
  --name canopy-mysql \
  -p 127.0.0.1:3308:3306 \
  -e MYSQL_ROOT_PASSWORD=root_dev_pw \
  -e MYSQL_DATABASE=canopy \
  -e MYSQL_USER=canopy \
  -e MYSQL_PASSWORD=canopy_dev_pw \
  mysql:8.0 \
  --character-set-server=utf8mb4 \
  --collation-server=utf8mb4_0900_ai_ci

# Create the integration-test database and grant access
docker exec -i canopy-mysql mysql -uroot -proot_dev_pw -e "
  CREATE DATABASE IF NOT EXISTS canopy_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
  GRANT ALL PRIVILEGES ON canopy.* TO 'canopy'@'%';
  GRANT ALL PRIVILEGES ON canopy_test.* TO 'canopy'@'%';
  FLUSH PRIVILEGES;
"

# Apply schema + seed (Spring Boot also verifies these idempotently on startup)
docker exec -i canopy-mysql mysql -ucanopy -pcanopy_dev_pw canopy < db/migrations/001_init.sql
docker exec -i canopy-mysql mysql -ucanopy -pcanopy_dev_pw canopy < db/seed.sql
```

### 2. Start the Spring Boot Backend (`http://localhost:8090`)

```bash
cd backend
mvn spring-boot:run
```

Health check:
```bash
curl http://localhost:8090/api/health
```

### 3. Start the Next.js Frontend (`http://localhost:3001`)

```bash
cd frontend
npm install
NEXT_PUBLIC_API_URL=http://localhost:8090 \
NEXT_PUBLIC_WS_URL=ws://localhost:8090 \
npm run dev
```

Open:
- Landing page: `http://localhost:3001/`
- Workspace: `http://localhost:3001/app`
- Multi-peer isolated browser tabs (uses per-tab `sessionStorage` + `?tabOnly=true` so you can test 2–7 independent room peers side by side in one browser): `http://localhost:3001/register?fresh=1`

### 4. Start the React Native + Expo Mobile App (`mobile/`)

```bash
cd mobile
npm install
npx expo start
```

- **Android Emulator**: Press `a` (`http://10.0.2.2:8090` auto-configured)
- **iOS Simulator**: Press `i` (`http://localhost:8090` auto-configured)
- **Physical Phone (Expo Go)**: Scan QR code and set your computer's LAN IP (`http://192.168.x.x:8090`) in the Sign-In **Server URL** panel
- **Expo Web Preview**: `npx expo start --web --port 19006` (see `mobile/README.md`)

---

## Verification & Tests

```bash
# 1. Backend end-to-end JUnit suite (7-user blind match, opt-out rematch, threads, polls, WS, WebRTC, zero-PII checks)
cd backend && mvn -B test

# 2. Frontend TypeScript strict check
cd frontend && npx tsc --noEmit

# 3. Reproducible MySQL EXPLAIN + EXPLAIN ANALYZE benchmark across all hot queries
docker exec -i canopy-mysql mysql --table -ucanopy -pcanopy_dev_pw canopy < db/verify_explain.sql

# 4. Landing page tasteskill gate check
node .agents/skills/design-taste-frontend/scripts/gate.mjs frontend/public/landing.html
```

---

## Deploy on PlanetScale (Vitess)

Canopy's schema (`db/migrations/001_init.sql`) is built natively for PlanetScale Vitess: narrow `BIGINT UNSIGNED` primary keys, `BINARY(16)` UUIDv7 public IDs, `DATETIME`, `utf8mb4_0900_ai_ci`, and zero `ENUM`s, foreign-key DDL, triggers, or stored procedures.

### 1. Create Database & Branch via PlanetScale CLI (`pscale`)

```bash
pscale auth login
pscale database create canopy --region us-east
pscale branch create canopy schema-init
```

### 2. Apply Schema & Seed on the Development Branch

```bash
pscale shell canopy schema-init < db/migrations/001_init.sql
pscale shell canopy schema-init < db/seed.sql
```

### 3. Promote via Non-Blocking Online DDL Deploy Request

```bash
pscale deploy-request create canopy schema-init
pscale deploy-request review canopy 1 --approve
pscale deploy-request deploy canopy 1
```

### 4. Apply Sharded Vitess VSchema (When Scaling Beyond Unsharded Primary)

`db/vschema.json` co-locates user-private tables (`users`, `user_interests`, `pod_opt_outs`, `user_bookmarks`) on `user_id_xxhash`, co-locates room/chat tables (`pods`, `pod_channels`, `pod_members`, `messages`, `message_attachments`, `message_reactions`, `polls`, `poll_votes`) on `pod_id_xxhash` with lookup vindexes and Vitess sequences in an unsharded `canopy_lookup` keyspace, and replicates `interests` as a reference table:

```bash
pscale vschema apply canopy main --vschema db/vschema.json
```

### 5. Create Production Credentials & Configure Runtime Environment

Generate a PlanetScale password (`pscale password create canopy main prod-app --role readwriter`) and start the backend and frontend with TLS enabled:

```bash
# Backend environment variables
export PORT=8090
export DB_URL="jdbc:mysql://aws.connect.psdb.cloud:3306/canopy?sslMode=VERIFY_IDENTITY&useUnicode=true&characterEncoding=utf8&connectionCollation=utf8mb4_0900_ai_ci&serverTimezone=UTC"
export DB_USER="<planetscale-username>"
export DB_PASSWORD="<planetscale-password>"
export CANOPY_JWT_SECRET="$(openssl rand -hex 32)"
export CANOPY_CORS_ORIGINS="https://app.canopy.example"
export CANOPY_UPLOADS_DIR="/var/lib/canopy/uploads"

cd backend
mvn -B -DskipTests package
java -jar target/canopy-backend-0.1.0.jar
```

```bash
# Frontend build & start
cd frontend
NEXT_PUBLIC_API_URL="https://api.canopy.example" \
NEXT_PUBLIC_WS_URL="wss://api.canopy.example" \
BACKEND_INTERNAL_URL="https://api.canopy.example" \
npm run build
npm run start
```
