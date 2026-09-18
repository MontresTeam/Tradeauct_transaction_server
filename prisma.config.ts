import { defineConfig } from "@prisma/config";

// The Transaction Server owns this schema. It is the migration authority for
// all financial-domain tables. Run `npm run db:migrate` to apply migrations.
// The Main Backend schema is completely independent.
export default defineConfig({
  schema: "prisma/schema",
});
