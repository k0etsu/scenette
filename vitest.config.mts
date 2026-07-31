import { defineConfig } from "vitest/config";

// One shared config for every workspace's tests rather than a config per
// package -- default environment is "node" (protocol/ws-client/
// websocket-handlers tests are pure logic or DynamoDB-mocked); DOM-heavy
// test files (control-ui/browser-source) opt into jsdom individually via a
// `// @vitest-environment jsdom` docblock comment at the top of the file.
export default defineConfig({
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "services/*/test/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
    ],
    environment: "node",
    // Lambda handler modules read these via `process.env.X!` at module
    // top-level (fine in a real deploy, where CDK sets them) -- since ES
    // module imports are hoisted above any code a test file could run
    // first, these have to be set here rather than per-test, or the
    // import itself would throw before a test even gets a chance to run.
    env: {
      CONNECTIONS_TABLE: "test-connections",
      ASSETS_TABLE: "test-assets",
      ROOMS_TABLE: "test-rooms",
      ACCOUNTS_TABLE: "test-accounts",
      SESSIONS_TABLE: "test-sessions",
      MEMBERSHIPS_TABLE: "test-memberships",
      EMAIL_VERIFICATIONS_TABLE: "test-email-verifications",
      VERIFICATION_FROM_ADDRESS: "noreply@test.example.com",
      HTTP_API_URL: "https://api.test.example.com",
    },
  },
});
