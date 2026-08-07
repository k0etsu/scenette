# browser-source

The read-only page OBS loads as a browser source. It renders the current viewport state (whatever assets intersect the fixed viewport rectangle) independently of whether anyone is connected to the control UI.

The URL carries an opaque `?obs=<key>` rather than the roomId itself — so a mod who knows the roomId can't reconstruct another room's source, and the owner can rotate the key to revoke a previously-shared URL. On load it reads `/config.json` for this env's endpoints (query params override for local testing), exchanges the `obs` key for the real roomId via the accounts service, fetches the current room-state snapshot, then opens its own **anonymous, read-only** WebSocket connection for live updates.

It uses the shared `@scenette/ws-client`, whose background reconnect routine survives API Gateway's 2-hour WebSocket connection limit and idle drops without visible flicker.

- `src/main.ts` — config/key resolution, the WebSocket connection, and applying incoming room updates.
- `src/render.ts` — draws the viewport and its assets.
