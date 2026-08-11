# control-ui

The streamer/mod-facing app: a dashboard of the rooms you own or moderate, then a real-time editing surface where collaborators upload/paste media, drag/zoom/pan assets, add text and template variables, preview the live stream embed, and manage access.

No framework — plain TypeScript bundled with esbuild, matching `apps/browser-source`. At load it fetches `/config.json` (written next to the build by CDK at deploy time) for this env's WebSocket/HTTP endpoints; `?roomId=...` selects the room, and auth is the `HttpOnly` session cookie set by the accounts service (there is no token in the page). Individual endpoints can be overridden with query params for local testing.

Key modules:
- `src/config.ts` / `src/auth.ts` — runtime config load, and the cookie-based session: login/register, a periodic session poll that slides the server-side TTL and re-issues the cookie, and a kick-to-login when the session lapses.
- `src/main.ts` — top-level wiring: dashboard vs. room view, the `@scenette/ws-client` connection, and the shared context menu.
- `src/canvas.ts` — the editing surface: world-space pan/zoom (local-only, not synced), the fixed viewport rectangle, drag-to-move, select, delete.
- `src/sidebar.ts` / `src/variablesPanel.ts` — per-asset properties, text styling, and template variables.
- `src/streamPreview.ts` — the live Twitch/YouTube embed preview panel.
- `src/upload.ts` / `src/uploadIndicator.ts` — the presigned-URL upload/paste flow (with client-side media-dimension detection) and its on-canvas progress indicator.
- `src/roomPicker.ts` / `src/accessModal.ts` / `src/settingsModal.ts` — the room dashboard (with the announcement banner and verify prompt), invite + mod-access management, and account settings.
- `src/connectedUsers.ts` — the live presence list of connected collaborators.
