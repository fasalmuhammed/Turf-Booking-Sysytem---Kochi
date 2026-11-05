import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { adminRouter } from './admin/router.js';
import { handleInbound } from './bot/engine.js';
import { publicRouter } from './routes/public.js';
import { whatsappWebhookRouter } from './whatsapp/webhook.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// works from both src/ (tsx) and dist/src/ (compiled)
const publicDir =
  [path.resolve(here, '../public'), path.resolve(here, '../../public')].find((p) => fs.existsSync(path.join(p, 'admin.css'))) ??
  path.resolve('public');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind ngrok / a load balancer

  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as Request).rawBody = Buffer.from(buf);
      },
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: '200kb' }));

  app.use('/static', express.static(publicDir, { maxAge: '1h', index: false }));
  app.use('/webhooks/whatsapp', whatsappWebhookRouter(handleInbound));
  app.use(publicRouter());
  app.use('/admin', adminRouter());
  app.get('/', (_req, res) => res.redirect('/admin'));

  app.use((_req, res) => res.status(404).send('Not found'));
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[http] unhandled error', err);
    if (!res.headersSent) res.status(500).send('Something went wrong. Please try again.');
  });
  return app;
}
