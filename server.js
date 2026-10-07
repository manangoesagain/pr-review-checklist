// The local server: serves the page from public/, and runs reviews at
// POST /api/review, streaming one JSON line per step and the Review at the end.
// Keys from .env stay here and never reach the browser.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import { loadEnvFile, readSettings } from './lib/env.js';
import { ReviewError, runReview } from './lib/review.js';

const projectFolder = path.dirname(fileURLToPath(import.meta.url));

function clientError(error) {
  if (error instanceof ReviewError) return { code: error.code, message: error.message, ...error.extra };
  console.error(`Review failed: ${error?.message ?? error}`); // Never logs the code being reviewed.
  return { code: 'server', message: 'Something went wrong on our side. Please try again.' };
}

export function createApp({ settings = readSettings(), reviewOptions = {} } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(path.join(projectFolder, 'public')));

  app.get('/api/health', (_req, res) => {
    res.json({ ai: Boolean(settings.nvidiaKey), model: settings.nvidiaKey ? settings.model : null });
  });

  app.post('/api/review', async (req, res) => {
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort(); // The page pressed Cancel or closed.
    });
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.flushHeaders();
    const send = (message) => {
      if (!res.writableEnded && !controller.signal.aborted) res.write(`${JSON.stringify(message)}\n`);
    };

    try {
      const review = await runReview(req.body ?? {}, {
        settings,
        signal: controller.signal,
        onStep: (step) => send({ step }),
        ...reviewOptions,
      });
      send({ review });
    } catch (error) {
      if (!controller.signal.aborted) send({ error: clientError(error) });
    } finally {
      res.end();
    }
  });

  // Oversized or broken requests get a plain JSON message instead of an HTML error page.
  app.use((err, _req, res, _next) => {
    const status = err.status ?? err.statusCode ?? 500;
    const message = status === 413
      ? 'That diff is over 1 MB. Paste a smaller part of it, or review the PR by its link.'
      : status < 500 ? 'That request didn\'t look right. Please try again.' : 'Something went wrong on our side. Please try again.';
    if (status >= 500) console.error(err.message);
    res.status(status).type('application/x-ndjson').send(`${JSON.stringify({ error: { code: status === 413 ? 'too-big' : 'bad-request', message } })}\n`);
  });

  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnvFile(path.join(projectFolder, '.env'));
  const settings = readSettings();
  const app = createApp({ settings });
  app.listen(settings.port, '127.0.0.1', () => {
    console.log(`PR Review Checklist is running at http://localhost:${settings.port}`);
    console.log(settings.nvidiaKey
      ? `AI reviewer: on (${settings.model})`
      : 'AI reviewer: off, so reviews use basic mode. Add NVIDIA_API_KEY to .env for the full review.');
  }).on('error', (error) => {
    console.error(error.code === 'EADDRINUSE'
      ? `Port ${settings.port} is already in use. Close the other app, or set PORT=3001 in .env.`
      : error.message);
    process.exitCode = 1;
  });
}
