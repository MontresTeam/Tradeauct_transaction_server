// Runs `stripe listen` against the same Stripe account the server uses.
// The CLI otherwise listens on whichever account `stripe login` selected, which
// silently receives no events when it differs from STRIPE_SECRET_KEY.
// Usage: node --env-file=.env.local scripts/stripe-listen.mjs
import { spawn } from "node:child_process";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error("STRIPE_SECRET_KEY is not set. Run via `npm run stripe:listen` from the repo root.");
  process.exit(1);
}

const port = process.env.PORT || "9101";
const args = [
  "listen",
  "--api-key",
  key,
  "--forward-to",
  `localhost:${port}/webhooks/stripe`,
  "--forward-connect-to",
  `localhost:${port}/webhooks/stripe/connect`,
];

console.log("Listening on the account behind STRIPE_SECRET_KEY.");
console.log("Copy the printed whsec_... into STRIPE_WEBHOOK_SECRET in .env.local if it differs, then restart the server.");

const child = spawn("stripe", args, { stdio: "inherit", shell: process.platform === "win32" });
child.on("exit", (code) => process.exit(code ?? 0));
