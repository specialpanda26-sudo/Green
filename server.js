import { makeDb } from './src/db.js';
import { createApp } from './src/app.js';
import { reconcile } from './src/payments.js';

const env = { ...process.env };
const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'ADMIN_KEY'].filter((k) => !env[k]);
if (missing.length) { console.error('Missing required environment variables: ' + missing.join(', ')); process.exit(1); }
if (env.ADMIN_KEY.length < 12) console.warn('WARNING: ADMIN_KEY is short. Use a long random string.');
for (const k of ['PAYHERO_API_KEY', 'PAYHERO_API_SECRET', 'PAYHERO_CHANNEL_ID', 'PAYHERO_CALLBACK_SECRET', 'CALLBACK_URL']) if (!env[k]) console.warn('WARNING: ' + k + ' is empty. Ticket payments will not work until it is set.');

const db = makeDb(env);
setInterval(() => reconcile({ db, env }).catch((e) => console.error('reconcile', e && e.message)), 60e3).unref();
createApp(env, db).listen(Number(env.PORT) || 3000, () => console.log('Greenline Buses listening on ' + (env.PORT || 3000)));
