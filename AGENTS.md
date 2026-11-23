# Workspace Agent Rules (`AGENTS.md`)

1. **Read `PLAN.md` first** for exact shared schemas, ports, bridge classes, REST DTOs, and WebSocket JSON frames.
2. **Use Installed Workspace Skills** in `.agents/skills/`:
   - Database & SQL changes MUST follow `.agents/skills/mysql/SKILL.md` and `.agents/skills/vitess/SKILL.md` (narrow `BIGINT UNSIGNED` PKs, `BINARY(16)` UUIDv7 public IDs, `utf8mb4_0900_ai_ci`, `DATETIME`, composite indexes, cursor pagination, `FULLTEXT` search, `EXPLAIN` verification).
   - All Java 21, Kotlin 2.x, and TypeScript/Next.js engineering MUST follow `.agents/skills/ponytail/SKILL.md` (smallest complete solution, explicit SQL via `JdbcClient`, zero Redux, Jotai atoms + TanStack Query/Virtual, test non-trivial logic, mark intentional v1 scale limits with `ponytail:`).
   - Landing page (`frontend/src/app/page.tsx` + static gate check) MUST follow `.agents/skills/design-taste-frontend/SKILL.md` (`tasteskill 2.5`) and pass `gate.mjs`.
   - Workspace UI (`/app`, `/login`, `/register`) MUST share the dealt `white-mint-tiles` + `Familjen Grotesk` / `IBM Plex Mono` tokens (`#ffffff` / `#f3f3f3` / `#232323` / `#a1ffcb` mint, zero violet, 44px touch targets, accessible labels).
3. **Strict File Ownership** — never edit files outside your assigned slice in `PLAN.md` and your agent prompt.
4. **Private Auth vs. Peer-Blind Rooms** — `users` stores `full_name`, `email`, `gender`, and `nationality_code` ONLY for authentication and `/api/auth/me`. NEVER include real names, emails, genders, nationalities, or raw `user_id`s in any pod, channel, message, reaction, poll, or WebSocket payload.
