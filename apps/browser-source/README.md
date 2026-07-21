# browser-source

The page OBS loads as a browser source. Renders the current viewport state (whatever assets intersect the fixed viewport rectangle) independently of whether anyone is connected to the control UI — see the plan's "browser source resilience" section.

On load: fetches the current room-state snapshot, then opens its own WebSocket connection for live updates. Runs a background reconnect routine to survive API Gateway's 2-hour WebSocket connection limit without any visible flicker.

Not yet scaffolded — infra and CI/CD are being stood up first.
