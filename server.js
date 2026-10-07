// The local server: serves the page from public/, and runs reviews at
// POST /api/review, streaming one JSON line per step and the Review at the end.
// Keys from .env stay here and never reach the browser.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createAiClient, resolveAi } from './lib/ai.js';
import { isMainModule, loadEnvFile, readSettings } from './lib/env.js';
import { createGitHubReader } from './lib/github.js';
import { ReviewError, runReview } from './lib/review.js';

const projectFolder = path.dirname(fileURLToPath(import.meta.url));

function clientError(error) {
  if (error instanceof ReviewError) return { code: error.code, message: error.message, ...error.extra };
  console.error(`Review failed: ${error?.message ?? error}`); // Never logs the code being reviewed.
  return { code: 'server', message: 'Something went wrong on our side. Please try again.' };
}

// `ai` is the AI client, or null for basic mode. By default it's made from the key in settings.
// `github` reads PRs by link, with the optional token and its own 10-minute cache.
export function createApp({
  settings = readSettings(),
  ai = settings.nvidiaKey ? createAiClient({ apiKey: settings.nvidiaKey, model: settings.model }) : null,
  github = createGitHubReader({ token: settings.githubToken }),
  reviewOptions = {},
} = {}) {
  const app = express();
  // The startup check can swap in a different model, so routes read app.locals.ai.
  app.locals.ai = ai;
  app.locals.aiProblem = null; // Set by the startup check if the key or model doesn't work.
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(path.join(projectFolder, 'public')));

  app.get('/api/health', (_req, res) => {
    const { ai: current, aiProblem } = app.locals;
    res.json({ ai: Boolean(current), model: current?.model ?? null, problem: aiProblem });
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
        ai: app.locals.ai,
        github,
        claimCheck: settings.claimCheck !== false,
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

if (isMainModule(import.meta.url)) {
  // Windows Notepad often saves ".env" as ".env.txt", so that name works too.
  if (!loadEnvFile(path.join(projectFolder, '.env')).found && loadEnvFile(path.join(projectFolder, '.env.txt')).found) {
    console.log('Read your settings from .env.txt (Windows added ".txt" to the name). That works fine.');
  }
  const settings = readSettings();
  const app = createApp({ settings });
  app.listen(settings.port, '127.0.0.1', async () => {
    console.log(`PR Review Checklist is running at http://localhost:${settings.port}`);
    if (!app.locals.ai) {
      console.log('AI reviewer: off, so reviews use basic mode. Add NVIDIA_API_KEY to .env for the full review.');
      return;
    }
    console.log(`AI reviewer: checking ${settings.model}...`);
    const check = await resolveAi({ apiKey: settings.nvidiaKey, model: settings.model, log: (line) => console.log(line) });
    app.locals.ai = check.client;
    app.locals.aiProblem = check.ok ? null : check.message;
    console.log(check.ok ? check.message : `AI reviewer problem: ${check.message}`);
  }).on('error', (error) => {
    console.error(error.code === 'EADDRINUSE'
      ? `Port ${settings.port} is already in use. Close the other app, or set PORT=3001 in .env.`
      : error.message);
    process.exitCode = 1;
  });
}
