import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { RelayConfig } from './config';

export class TrialError extends Error {
  constructor(readonly code: 'trial_exhausted' | 'trial_unavailable' | 'trial_invalid', readonly status = 503) {
    super(code === 'trial_exhausted' ? '免费体验额度已用完' : code === 'trial_invalid' ? '试用请求无效，请重新开始搜索' : '免费体验暂不可用，请稍后重试或配置自己的 API Key');
  }
}

export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const periodKeys = (time: number) => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(time);
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  const day = `${get('year')}-${get('month')}-${get('day')}`;
  return [day, day.slice(0, 7)];
};

interface Run { owner: string; expires: number; state: string; calls: number; reranked: number; cost: number }

export class TrialStore {
  readonly db: DatabaseSync;
  constructor(path: string, private readonly now = Date.now) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS installs (id TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL,
        state TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, reranked INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS spend (period TEXT PRIMARY KEY, cost REAL NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS registrations (day TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0);
      UPDATE runs SET state='ended' WHERE state='pending';
    `);
  }
  register() {
    const day = periodKeys(this.now())[0];
    if (Number(this.db.prepare('SELECT count FROM registrations WHERE day=?').get(day)?.count ?? 0) >= 1000) throw new TrialError('trial_unavailable', 429);
    const token = randomBytes(32).toString('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO installs(id) VALUES (?)').run(tokenHash(token));
      this.db.prepare('INSERT INTO registrations(day,count) VALUES (?,1) ON CONFLICT(day) DO UPDATE SET count=count+1').run(day);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return token;
  }
  owner(token: string) {
    if (!/^[a-f0-9]{64}$/u.test(token)) throw new TrialError('trial_invalid', 401);
    const id = tokenHash(token);
    if (!this.db.prepare('SELECT id FROM installs WHERE id=?').get(id)) throw new TrialError('trial_invalid', 401);
    return id;
  }
  remaining(owner: string) {
    return 5 - Number(this.db.prepare('SELECT used FROM installs WHERE id=?').get(owner)!.used);
  }
  available(config: RelayConfig) {
    return config.enabled && periodKeys(this.now()).every((period, index) =>
      Number(this.db.prepare('SELECT cost FROM spend WHERE period=?').get(period)?.cost ?? 0) < (index === 0 ? config.dailyBudget : config.monthlyBudget));
  }
  begin(owner: string, id: string) {
    this.db.prepare('DELETE FROM runs WHERE expires<?').run(this.now());
    if (this.remaining(owner) <= 0) throw new TrialError('trial_exhausted', 403);
    if (this.db.prepare('SELECT id FROM runs WHERE owner=? AND state=\'pending\'').get(owner)
      || this.db.prepare('SELECT id FROM runs WHERE id=?').get(id)) throw new TrialError('trial_invalid', 409);
    this.db.prepare('UPDATE runs SET state=\'ended\' WHERE owner=? AND state=\'active\'').run(owner);
    this.db.prepare('INSERT INTO runs(id,owner,expires,state) VALUES (?,?,?,\'pending\')').run(id, owner, this.now() + 2 * 60 * 60 * 1000);
  }
  run(owner: string, id: string): Run {
    const run = this.db.prepare('SELECT * FROM runs WHERE id=? AND owner=? AND expires>?').get(id, owner, this.now()) as unknown as Run | undefined;
    if (!run) throw new TrialError('trial_invalid', 409);
    return run;
  }
  commit(owner: string, id: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.run(owner, id).state === 'pending') {
        this.db.prepare('UPDATE installs SET used=used+1 WHERE id=? AND used<5').run(owner);
        this.db.prepare('UPDATE runs SET state=\'active\' WHERE id=?').run(id);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  finish(owner: string, id: string) {
    this.db.prepare('UPDATE runs SET state=\'ended\' WHERE id=? AND owner=?').run(id, owner);
  }
  reserve(owner: string, id: string, cost: number, config: RelayConfig, rerank: boolean) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const run = this.run(owner, id);
      if (!config.enabled || run.cost + cost > config.searchBudget) throw new TrialError('trial_unavailable');
      if (run.calls >= 32 || run.reranked || !['pending', 'active'].includes(run.state)) throw new TrialError('trial_invalid', 409);
      const periods = periodKeys(this.now());
      for (const [index, period] of periods.entries()) {
        const used = Number(this.db.prepare('SELECT cost FROM spend WHERE period=?').get(period)?.cost ?? 0);
        if (used + cost > (index === 0 ? config.dailyBudget : config.monthlyBudget)) throw new TrialError('trial_unavailable');
        this.db.prepare('INSERT INTO spend(period,cost,calls) VALUES (?,?,1) ON CONFLICT(period) DO UPDATE SET cost=cost+excluded.cost,calls=calls+1').run(period, cost);
      }
      this.db.prepare('UPDATE runs SET cost=cost+?,calls=calls+1,reranked=? WHERE id=?').run(cost, Number(rerank), id);
      this.db.exec('COMMIT');
      return periods;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  settle(id: string, periods: string[], reserved: number, actual: number, failed: boolean) {
    // Unknown provider usage retains the reservation. It may already have been billed.
    const adjustment = actual - reserved;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const period of periods) this.db.prepare('UPDATE spend SET cost=MAX(0,cost+?),errors=errors+? WHERE period=?').run(adjustment, Number(failed), period);
      this.db.prepare('UPDATE runs SET cost=MAX(0,cost+?) WHERE id=?').run(adjustment, id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
