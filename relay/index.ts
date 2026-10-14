import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from './config';
import { TrialStore } from './store';
import { RelayService } from './service';
import { createRelayServer } from './http';

const path = process.env.TRIAL_DB_PATH ?? '/var/lib/zju-search/trial.sqlite';
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
const store = new TrialStore(path);
const config = loadConfig(process.env);
const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const server = createRelayServer(new RelayService(store, config));
server.listen(port, '127.0.0.1', () => {
  console.info(`Trial relay listening on loopback port ${port}; enabled=${config.enabled}`);
});
const stop = () => server.close(() => { store.db.close(); process.exit(0); });
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
