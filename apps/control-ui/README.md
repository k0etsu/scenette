# control-ui

The streamer/mod-facing canvas editor: upload/paste media, drag assets, zoom/pan, manage invites, and the live Twitch/YouTube embed preview.

Not yet scaffolded — infra and CI/CD are being stood up first. Planned stack: a Vite + React (or Vue) SPA, deployed as a static site to S3 + CloudFront, talking to the WebSocket API and HTTP auth-broker API defined in `infra/`.
