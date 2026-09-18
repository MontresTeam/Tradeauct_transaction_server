/**
 * Generate the service-to-service credentials used by both servers.
 *
 * Prints two blocks: one for this server and one for TradeAuct_backend_server.
 * Each service keeps its own ES256 private key and the peer's public key; the
 * HMAC secret is shared, because it signs the request body in both directions.
 *
 * Nothing is written to disk — copy the blocks into the respective secret
 * stores yourself, so a generated key never sits in a file you forgot about.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";

function escapeForEnv(pem: string): string {
  return pem.trim().replace(/\n/g, "\\n");
}

function keyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return { privateKey, publicKey };
}

const main = keyPair();
const txn = keyPair();
const hmacSecret = randomBytes(48).toString("base64url");
const keyId = `k${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;

console.log("# ---------------------------------------------------------------");
console.log("# Tradeauct-transaction-server  (.env.local)");
console.log("# ---------------------------------------------------------------");
console.log(`SERVICE_KEY_ID=${keyId}`);
console.log(`SERVICE_HMAC_SECRET=${hmacSecret}`);
console.log(`SERVICE_JWT_PUBLIC_KEY_MAIN="${escapeForEnv(main.publicKey)}"`);
console.log(`SERVICE_JWT_PRIVATE_KEY_TXN="${escapeForEnv(txn.privateKey)}"`);
console.log("");
console.log("# ---------------------------------------------------------------");
console.log("# TradeAuct_backend_server  (.env.local)");
console.log("# ---------------------------------------------------------------");
console.log(`SERVICE_KEY_ID=${keyId}`);
console.log(`SERVICE_HMAC_SECRET=${hmacSecret}`);
console.log(`SERVICE_JWT_PRIVATE_KEY_MAIN="${escapeForEnv(main.privateKey)}"`);
console.log(`SERVICE_JWT_PUBLIC_KEY_TXN="${escapeForEnv(txn.publicKey)}"`);
console.log("");
console.log("# Rotation: put the outgoing values in SERVICE_KEY_ID_PREVIOUS /");
console.log("# SERVICE_HMAC_SECRET_PREVIOUS on the transaction server, deploy both");
console.log("# services with the new key, then drop the PREVIOUS pair.");
