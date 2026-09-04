// @ts-nocheck
// Vercel serverless entry. All routes are rewritten here (see vercel.json).
//
// It imports the COMPILED app from `dist/` (produced by `npm run build`, i.e.
// tsc via nest — which emits the decorator metadata Nest's DI needs and esbuild
// would otherwise drop). This shim is transpiled by @vercel/node and is excluded
// from the project's `tsc` typecheck on purpose.
import 'reflect-metadata';
import express from 'express';
import { createNestApp } from '../dist/bootstrap';

const server = express();
let ready = null;

function ensureReady() {
  if (!ready) {
    ready = createNestApp(server).then(() => undefined);
  }
  return ready;
}

export default async function handler(req, res) {
  await ensureReady();
  server(req, res);
}
