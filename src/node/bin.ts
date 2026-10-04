#!/usr/bin/env node
// The instagram-monitor executable; everything it does is in cli.ts.

import { main } from "./cli.js";

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`instagram-monitor: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
