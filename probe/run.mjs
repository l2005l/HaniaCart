import { sportApi } from './api.mjs';
import zlib from 'zlib';
const all = {};
for (const p of ['il', 'euro', 'nba', 'world?d=20261108']) {
  const r = await sportApi(new Request('https://sport.hania360.com/api/sport/' + p), null);
  const t = await r.text(); all[p] = JSON.parse(t); if (r.status !== 200) console.log('ERR', p, t);
}
console.log('FX ' + zlib.gzipSync(JSON.stringify(all)).toString('base64'));
