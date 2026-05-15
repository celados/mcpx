#!/usr/bin/env bun
import { runMcpx } from "./router";
import { runSchemaRefreshWorker, shouldRunSchemaRefreshWorker } from "./schema-refresh";

if (shouldRunSchemaRefreshWorker()) {
  await runSchemaRefreshWorker();
} else {
  await runMcpx(process.argv.slice(2), process.cwd(), import.meta.path);
}
