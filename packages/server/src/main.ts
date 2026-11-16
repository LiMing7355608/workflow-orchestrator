import { buildApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const logPath = process.env.EVENT_LOG_PATH ?? './data/events.jsonl';

const { app } = await buildApp({ logPath, logger: false });

try {
  await app.listen({ port, host });
  console.log(`orchestrator server listening on http://${host}:${port}`);
  console.log(`event log: ${logPath}`);
} catch (error) {
  console.error('failed to start orchestrator server', error);
  process.exit(1);
}
