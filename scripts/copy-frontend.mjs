#!/usr/bin/env node
/**
 * Copies the app's frontend (src/) into dist/, which Tauri bundles into the
 * app. There is no bundler: the browser loads the same ES modules in Edge dev
 * mode and in the app. Source maps stay out of the installer.
 */
import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const DIST = path.join(ROOT, "dist");

await rm(DIST, { recursive: true, force: true });
await cp(SRC, DIST, { recursive: true, filter: (file) => !file.endsWith(".map") });
console.log(`Copied ${path.relative(ROOT, SRC)}/ to ${path.relative(ROOT, DIST)}/ (no source maps).`);
