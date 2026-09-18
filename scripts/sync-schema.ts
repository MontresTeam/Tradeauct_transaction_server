/**
 * The Prisma schema is owned by TradeAuct_backend_server.
 *
 * This server shares the same database but must never migrate it, so it keeps
 * a copy of the schema purely to generate a client. `sync` refreshes that copy
 * and records a checksum; `check` fails when the copy has drifted from the
 * source, which is what stops a stale Prisma client from reaching production.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const SOURCE_SCHEMA_DIR = path.resolve(
  root,
  process.env.SCHEMA_SOURCE_DIR ?? "../TradeAuct_backend_server/prisma/schema",
);
const LOCAL_SCHEMA_DIR = path.join(root, "prisma", "schema");
const CHECKSUM_FILE = path.join(root, "prisma", ".schema-checksum");

function readSchemaFiles(dir: string): Array<{ name: string; content: string }> {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".prisma"))
    .sort()
    .map((name) => ({ name, content: fs.readFileSync(path.join(dir, name), "utf8") }));
}

function checksum(files: Array<{ name: string; content: string }>): string {
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(file.name);
    hash.update("\0");
    hash.update(file.content.replace(/\r\n/g, "\n"));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function sync(): void {
  const source = readSchemaFiles(SOURCE_SCHEMA_DIR);
  if (source.length === 0) {
    console.error(`[schema] No .prisma files found in ${SOURCE_SCHEMA_DIR}`);
    process.exit(1);
  }

  fs.rmSync(LOCAL_SCHEMA_DIR, { recursive: true, force: true });
  fs.mkdirSync(LOCAL_SCHEMA_DIR, { recursive: true });
  for (const file of source) {
    fs.writeFileSync(path.join(LOCAL_SCHEMA_DIR, file.name), file.content);
  }
  fs.writeFileSync(CHECKSUM_FILE, `${checksum(source)}\n`);
  console.log(`[schema] Synced ${source.length} files from ${SOURCE_SCHEMA_DIR}`);
}

function check(): void {
  const local = readSchemaFiles(LOCAL_SCHEMA_DIR);
  if (local.length === 0) {
    console.error("[schema] No local schema copy. Run: npm run prisma:sync");
    process.exit(1);
  }

  const recorded = fs.existsSync(CHECKSUM_FILE) ? fs.readFileSync(CHECKSUM_FILE, "utf8").trim() : "";
  const localSum = checksum(local);
  if (recorded !== localSum) {
    console.error("[schema] Local schema copy does not match its recorded checksum. Run: npm run prisma:sync");
    process.exit(1);
  }

  const source = readSchemaFiles(SOURCE_SCHEMA_DIR);
  if (source.length === 0) {
    console.warn(`[schema] Source schema not reachable at ${SOURCE_SCHEMA_DIR}; checked local integrity only.`);
    return;
  }

  const sourceSum = checksum(source);
  if (sourceSum !== localSum) {
    console.error("[schema] Schema drift: TradeAuct_backend_server has changed. Run: npm run prisma:sync && npm run prisma:generate");
    process.exit(1);
  }

  console.log("[schema] In sync with TradeAuct_backend_server.");
}

const command = process.argv[2] ?? "check";
if (command === "sync") {
  sync();
} else if (command === "check") {
  check();
} else {
  console.error(`Unknown command: ${command}. Use "sync" or "check".`);
  process.exit(1);
}
