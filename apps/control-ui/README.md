# control-ui

The streamer/mod-facing canvas editor: upload/paste media, drag assets, zoom/pan, and (planned) manage invites and the live Twitch/YouTube embed preview.

No framework — plain TypeScript bundled with esbuild, matching `apps/browser-source`. Query params configure it at load time (no build-time config): `?roomId=...&wsUrl=wss://.../dev&httpApiUrl=https://.../`.

- `src/canvas.ts` — the editing surface: world-space pan/zoom (local-only, not synced between collaborators), the fixed viewport rectangle, drag-to-move assets, select + delete.
- `src/upload.ts` — the upload/paste-to-upload flow: requests a pre-signed S3 PUT URL from the `upload-url` service, uploads directly, then detects media dimensions client-side.
- `src/main.ts` — wires the WebSocket connection (`@scenette/ws-client`) to the canvas and upload flow.

Not yet built: invite management UI and the live platform embed preview (both still pending in the task list).
