#!/usr/bin/env node
//
// Three pre-registered questions about integrating a self-hosted WooCommerce
// shop, and one verdict each. Run ./setup.sh first.
//
//   1. wc-auth   Does the one-click key grant still work, and do the keys it
//                hands out actually authenticate against wc/v3?
//   2. Store API Does GET /wp-json/wc/store/v1/products serve the catalogue
//                with no auth, out of the box?
//   3. Order     Does POST /wp-json/wc/v3/orders with set_paid:true, using
//                those keys, produce an order the shop itself calls paid?
//
// A verdict is PASS, FAIL, or BLOCKED(reason). PASS and FAIL are both answers
// and exit 0. BLOCKED means the probe could not reach the question at all, and
// exits non-zero.
//
// Every evidence line is something a command or a response actually said. If
// you find a line here that is a paraphrase, it is a bug.

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOP_HTTP = 'http://localhost:8088';
const SHOP_HTTPS = 'https://localhost:8443';
// How the shop, from inside the compose network, addresses the receiver.
const CALLBACK_URL = 'https://callback/wc-auth-callback';
const RETURN_URL = 'https://callback/return';
const APP_NAME = 'Agentify';
const APP_USER_ID = 'agentify-merchant-1';
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'agentify-dev-admin';

// A probe that can only report PASS proves nothing. With PROBE_NEGATIVE_CONTROL=1
// the granted secret is corrupted by one character and the catalogue question is
// asked of wc/v3 (which requires authentication) instead of the Store API. Every
// verdict must flip to FAIL. If any stays PASS, the probe is measuring nothing
// and its green is worthless.
const NEGATIVE_CONTROL = process.env.PROBE_NEGATIVE_CONTROL === '1';

const PROBE_DIR = join(HERE, 'var/probe');
const CALLBACK_DIR = join(HERE, 'var/callback');
const FLAG_FILE = join(PROBE_DIR, 'allow-private-callback');
const SHOP_CA = join(HERE, 'var/certs/shop-cert.pem');
const CALLBACK_CA = join(HERE, 'var/certs/callback-cert.pem');

// ---------------------------------------------------------------- plumbing

class Blocked extends Error {}

function shopCa() {
  return readFileSync(SHOP_CA);
}

/**
 * One HTTP round trip. No redirect following: where a redirect happens it is
 * itself the answer we are after, so the Location header must survive.
 */
function http(url, opts = {}) {
  const { method = 'GET', headers = {}, body = null, ca = null } = opts;
  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  const fn = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const req = fn(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers,
        ...(ca ? { ca, servername: u.hostname } : {}),
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            setCookie: res.headers['set-cookie'] ?? [],
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

class Jar {
  constructor() {
    this.cookies = new Map();
  }
  absorb(setCookie) {
    for (const line of setCookie) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      if (idx < 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value === 'deleted' || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  set(name, value) {
    this.cookies.set(name, value);
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  names() {
    return [...this.cookies.keys()];
  }
}

/**
 * WooCommerce's OAuth 1.0a one-legged signing, transcribed from
 * class-wc-rest-authentication.php (check_oauth_signature, normalize_parameters,
 * join_with_equals_sign) and wc-rest-functions.php (wc_rest_urlencode_rfc3986).
 * The double encoding of "key=value" is theirs, not a mistake here.
 */
function enc(s) {
  return encodeURIComponent(String(s)).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function signedUrl(method, url, consumerKey, consumerSecret) {
  const u = new URL(url);
  const params = {};
  for (const [k, v] of u.searchParams) params[k] = v;
  params.oauth_consumer_key = consumerKey;
  params.oauth_timestamp = String(Math.floor(Date.now() / 1000));
  params.oauth_nonce = randomBytes(16).toString('hex');
  params.oauth_signature_method = 'HMAC-SHA256';

  const sorted = Object.keys(params).sort();
  const joined = sorted.map((k) => enc(`${enc(k)}=${enc(params[k])}`));
  const baseUri = enc(`${u.protocol}//${u.host}${u.pathname}`);
  const stringToSign = `${method}&${baseUri}&${joined.join('%26')}`;
  const signature = createHmac('sha256', `${consumerSecret}&`)
    .update(stringToSign)
    .digest('base64');

  const out = new URL(url);
  for (const k of Object.keys(params)) out.searchParams.set(k, params[k]);
  out.searchParams.set('oauth_signature', signature);
  return out.toString();
}

function basicHeader(key, secret) {
  return 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64');
}

function wpCli(args) {
  return execFileSync(
    'docker',
    ['compose', 'run', '--rm', '-T', 'cli', 'wp', ...args],
    { cwd: HERE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim();
}

function readJsonl(name) {
  const p = join(PROBE_DIR, name);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { unparsed: l };
      }
    });
}

function clearInstrument() {
  mkdirSync(PROBE_DIR, { recursive: true });
  mkdirSync(CALLBACK_DIR, { recursive: true });
  for (const f of ['http.jsonl', 'mail.jsonl']) {
    try {
      writeFileSync(join(PROBE_DIR, f), '');
    } catch {
      /* created by the container on first write */
    }
  }
  for (const f of [join(CALLBACK_DIR, 'received.json'), FLAG_FILE]) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* ignore */
    }
  }
}

function trunc(s, n = 300) {
  const one = String(s).replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}… [${one.length} chars total]` : one;
}

// ------------------------------------------------------------- probe 1

async function login() {
  const jar = new Jar();
  // WordPress refuses the login form unless the browser demonstrated it keeps
  // cookies. This is that demonstration.
  jar.set('wordpress_test_cookie', 'WP%20Cookie%20check');
  const form = new URLSearchParams({
    log: ADMIN_USER,
    pwd: ADMIN_PASS,
    'wp-submit': 'Log In',
    redirect_to: `${SHOP_HTTP}/wp-admin/`,
    testcookie: '1',
  }).toString();

  const res = await http(`${SHOP_HTTP}/wp-login.php`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': Buffer.byteLength(form),
      cookie: jar.header(),
    },
    body: form,
  });
  jar.absorb(res.setCookie);
  const loggedIn = jar.names().some((n) => n.startsWith('wordpress_logged_in_'));
  return { jar, res, loggedIn };
}

function authorizeUrl() {
  const q = new URLSearchParams({
    app_name: APP_NAME,
    scope: 'read_write',
    user_id: APP_USER_ID,
    return_url: RETURN_URL,
    callback_url: CALLBACK_URL,
  });
  return `${SHOP_HTTP}/wc-auth/v1/authorize?${q.toString()}`;
}

function extractApproveUrl(html) {
  const m = html.match(/<a href="([^"]+)"[^>]*class="[^"]*wc-auth-approve[^"]*"/);
  if (!m) return null;
  // esc_url() emits &#038; for the separator, not &amp;. Missing that turns
  // every parameter after the first into part of the previous one, and the
  // shop answers "Missing parameter user_id" — which looks like a wc-auth
  // defect and is not one.
  return m[1]
    .replace(/&#0?38;/g, '&')
    .replace(/&amp;/g, '&');
}

async function probeWcAuth(evidence, session) {
  const url = authorizeUrl();
  evidence.push(`authorize URL: ${url}`);

  const { jar, res: loginRes, loggedIn } = session;
  evidence.push(
    `POST /wp-login.php -> ${loginRes.status}; cookies now: ${jar.names().join(', ')}`
  );
  if (!loggedIn) {
    throw new Blocked('could not establish an admin session on the shop');
  }

  // --- the approve screen
  const grant = await http(url, { headers: { cookie: jar.header() } });
  evidence.push(`GET /wc-auth/v1/authorize -> ${grant.status}`);
  if (grant.status !== 200) {
    evidence.push(`  body: ${trunc(grant.body)}`);
    throw new Blocked(`the authorize endpoint answered ${grant.status}`);
  }
  const approveUrl = extractApproveUrl(grant.body);
  if (!approveUrl) {
    evidence.push(`  body: ${trunc(grant.body)}`);
    throw new Blocked('no Approve link on the authorize page');
  }
  evidence.push(
    `  approve control is <a href> (a GET), nonce-carrying: ${approveUrl.replace(
      /(wc_auth_nonce=)[a-z0-9]+/i,
      '$1<nonce>'
    )}`
  );
  const scopeShown = /Read\/Write/.test(grant.body);
  evidence.push(`  page states the scope Read/Write: ${scopeShown}`);

  // --- attempt A: a stock shop, no local allowances
  const beforeStock = readJsonl('http.jsonl').length;
  const stock = await http(approveUrl, { headers: { cookie: jar.header() } });
  const stockError = (stock.body.match(/Error:[^<]*/) || [''])[0].trim();
  evidence.push(
    `Approve on a stock shop -> ${stock.status}${stockError ? `; "${stockError}"` : ''}`
  );
  for (const r of readJsonl('http.jsonl').slice(beforeStock)) {
    evidence.push(
      `  shop outbound: ${r.method || '-'} ${r.url} -> ${r.status ?? r.error_code ?? r.note ?? '?'}` +
        (r.error_message ? ` (${r.error_message})` : '')
    );
  }
  evidence.push(
    '  this is the laptop, not wc-auth: the receiver sits on the compose network at ' +
      '172.x behind a self-signed certificate, and wc-auth posts through ' +
      'wp_safe_remote_post, which refuses private addresses. A merchant shop posting ' +
      'to a public https endpoint meets neither obstacle.'
  );

  // --- attempt B: with the two local allowances the instrument can grant
  writeFileSync(FLAG_FILE, 'see mu-plugins/agentify-probe.php\n');
  const grant2 = await http(url, { headers: { cookie: jar.header() } });
  const approveUrl2 = extractApproveUrl(grant2.body);
  if (!approveUrl2) throw new Blocked('no Approve link on the second authorize page');

  const granted = await http(approveUrl2, { headers: { cookie: jar.header() } });
  evidence.push(
    `Approve with the local allowances -> ${granted.status}` +
      (granted.headers.location ? `; Location: ${granted.headers.location}` : '')
  );

  const outbound = readJsonl('http.jsonl').filter((r) => String(r.url || '').includes('callback'));
  for (const r of outbound) {
    evidence.push(
      `  shop outbound: ${r.method || '-'} ${r.url} -> ${
        r.status ?? r.error_code ?? r.note ?? '?'
      }${r.error_message ? ` (${r.error_message})` : ''}`
    );
  }

  const receivedPath = join(CALLBACK_DIR, 'received.json');
  if (!existsSync(receivedPath)) {
    evidence.push('the callback receiver got nothing');
    return { verdict: 'FAIL', keys: null };
  }

  const received = JSON.parse(readFileSync(receivedPath, 'utf8'));
  const payload = JSON.parse(received.raw);
  evidence.push(
    `callback receiver got POST ${received.headers['content-type']} from ${
      received.headers['user-agent']
    }`
  );
  evidence.push(
    `  payload keys: ${Object.keys(payload).join(', ')}; key_permissions=${
      payload.key_permissions
    }; user_id=${payload.user_id}`
  );
  evidence.push(
    `  consumer_key=${payload.consumer_key.slice(0, 6)}…${payload.consumer_key.slice(
      -4
    )} (${payload.consumer_key.length} chars), consumer_secret=${payload.consumer_secret.slice(
      0,
      6
    )}…${payload.consumer_secret.slice(-4)} (${payload.consumer_secret.length} chars)`
  );

  const ck = payload.consumer_key;
  let cs = payload.consumer_secret;
  if (NEGATIVE_CONTROL) {
    cs = cs.slice(0, -1) + (cs.endsWith('a') ? 'b' : 'a');
    evidence.push('NEGATIVE CONTROL: the consumer secret was corrupted by one character');
  }

  // --- do the granted keys authenticate? Both doors, because WooCommerce
  //     picks the scheme from is_ssl().
  const overHttps = await http(`${SHOP_HTTPS}/wp-json/wc/v3/products?per_page=100`, {
    headers: { authorization: basicHeader(ck, cs) },
    ca: shopCa(),
  });
  let httpsCount = null;
  if (overHttps.status === 200) httpsCount = JSON.parse(overHttps.body).length;
  evidence.push(
    `GET wc/v3/products over https with HTTP Basic -> ${overHttps.status}` +
      (httpsCount !== null ? `; ${httpsCount} products` : `; ${trunc(overHttps.body, 160)}`)
  );

  const basicOverHttp = await http(`${SHOP_HTTP}/wp-json/wc/v3/products?per_page=1`, {
    headers: { authorization: basicHeader(ck, cs) },
  });
  evidence.push(
    `GET wc/v3/products over http with HTTP Basic -> ${basicOverHttp.status}; ${trunc(
      basicOverHttp.body,
      200
    )}`
  );

  const signed = signedUrl('GET', `${SHOP_HTTP}/wp-json/wc/v3/products?per_page=100`, ck, cs);
  const oauthOverHttp = await http(signed);
  let oauthCount = null;
  if (oauthOverHttp.status === 200) oauthCount = JSON.parse(oauthOverHttp.body).length;
  evidence.push(
    `GET wc/v3/products over http with OAuth 1.0a signature -> ${oauthOverHttp.status}` +
      (oauthCount !== null ? `; ${oauthCount} products` : `; ${trunc(oauthOverHttp.body, 200)}`)
  );

  // --- and is the key visible to the merchant afterwards?
  const rows = wpCli([
    'db',
    'query',
    'SELECT key_id, description, permissions, truncated_key FROM wp_woocommerce_api_keys',
    '--skip-column-names',
  ]);
  for (const line of rows.split('\n').filter(Boolean)) {
    evidence.push(`  wp_woocommerce_api_keys row: ${line.replace(/\t/g, ' | ')}`);
  }
  evidence.push(
    '  key_id gaps are the refused grants: wc-auth writes the key row before it posts ' +
      'and deletes it again when the post fails (class-wc-auth.php, maybe_delete_key), ' +
      'so a failed grant leaves no usable key behind.'
  );

  const pass = overHttps.status === 200 && httpsCount > 0;
  return { verdict: pass ? 'PASS' : 'FAIL', keys: pass ? { ck, cs } : null };
}

// ------------------------------------------------------------- probe 2

async function probeStoreApi(evidence) {
  // In negative-control mode the same question is put to wc/v3, which requires
  // authentication. A probe that reports the catalogue "public" there is not
  // reading the answer.
  const url = NEGATIVE_CONTROL
    ? `${SHOP_HTTP}/wp-json/wc/v3/products`
    : `${SHOP_HTTP}/wp-json/wc/store/v1/products`;
  if (NEGATIVE_CONTROL) evidence.push('NEGATIVE CONTROL: asking wc/v3 instead of the Store API');
  const res = await http(url, { headers: { accept: 'application/json' } });
  evidence.push(`GET ${url} (no Authorization header, no cookie) -> ${res.status}`);
  if (res.status !== 200) {
    evidence.push(`  body: ${trunc(res.body)}`);
    return 'FAIL';
  }
  let products;
  try {
    products = JSON.parse(res.body);
  } catch {
    evidence.push(`  body was not JSON: ${trunc(res.body)}`);
    return 'FAIL';
  }
  evidence.push(`  ${products.length} products, response was ${res.body.length} bytes`);
  for (const p of products) {
    evidence.push(
      `  id=${p.id} sku=${p.sku} name=${JSON.stringify(p.name)} price=${
        p.prices?.price
      } ${p.prices?.currency_code} type=${p.type} description=${
        (p.description || '').length
      } chars`
    );
  }
  const wanted = ['agentify-access-code', 'agentify-tote', 'agentify-abonement'];
  const got = products.map((p) => p.sku);
  const missing = wanted.filter((s) => !got.includes(s));
  evidence.push(
    missing.length ? `  missing seeded SKUs: ${missing.join(', ')}` : '  all three seeded SKUs present'
  );
  return missing.length === 0 ? 'PASS' : 'FAIL';
}

// ------------------------------------------------------------- probe 3

async function probeOrder(evidence, keys, jar) {
  if (!keys) throw new Blocked('probe 1 produced no working key pair to use');

  const list = await http(`${SHOP_HTTPS}/wp-json/wc/v3/products?sku=agentify-access-code`, {
    headers: { authorization: basicHeader(keys.ck, keys.cs) },
    ca: shopCa(),
  });
  const found = JSON.parse(list.body);
  if (!found.length) throw new Blocked('the Access code product is not in the catalogue');
  const productId = found[0].id;
  evidence.push(`ordering product id=${productId} sku=${found[0].sku} price=${found[0].price}`);

  const mailBefore = readJsonl('mail.jsonl').length;

  const body = JSON.stringify({
    payment_method: 'agentify',
    payment_method_title: 'Agentify (probe)',
    transaction_id: 'probe-tx-0001',
    set_paid: true,
    billing: {
      first_name: 'Probe',
      last_name: 'Buyer',
      address_1: '1 Probe Street',
      city: 'San Francisco',
      state: 'CA',
      postcode: '94110',
      country: 'US',
      email: 'buyer@example.test',
    },
    line_items: [{ product_id: productId, quantity: 1 }],
  });

  const created = await http(`${SHOP_HTTPS}/wp-json/wc/v3/orders`, {
    method: 'POST',
    headers: {
      authorization: basicHeader(keys.ck, keys.cs),
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    },
    body,
    ca: shopCa(),
  });
  evidence.push(`POST wc/v3/orders (set_paid:true) -> ${created.status}`);
  if (created.status !== 201) {
    evidence.push(`  body: ${trunc(created.body, 400)}`);
    return 'FAIL';
  }
  const order = JSON.parse(created.body);
  evidence.push(
    `  response: id=${order.id} number=${order.number} status=${order.status} total=${order.total} ${order.currency} date_paid=${order.date_paid} transaction_id=${order.transaction_id}`
  );

  // Second witness: the shop's own object layer, reached without going through
  // the REST route that just answered. A witness that cannot be read is a
  // thinner answer, not an unanswerable question, so none of these abort.
  try {
    const viaCli = wpCli([
      'wc',
      'shop_order',
      'get',
      String(order.id),
      '--user=admin',
      '--fields=id,status,total,currency,payment_method,transaction_id,date_paid',
      '--format=csv',
    ]);
    for (const line of viaCli.split('\n').filter(Boolean)) {
      evidence.push(`  wp wc shop_order get ${order.id}: ${line}`);
    }
  } catch (err) {
    evidence.push(`  wp wc shop_order get failed: ${trunc(err.message, 160)}`);
  }

  // Third witness: raw storage. Which table that is depends on whether the
  // shop turned on high-performance order storage, and a WP-CLI install of
  // WooCommerce 11 does not.
  let hpos = 'unknown';
  try {
    hpos = wpCli(['option', 'get', 'woocommerce_custom_orders_table_enabled']);
  } catch {
    hpos = 'unset';
  }
  evidence.push(`  order storage: woocommerce_custom_orders_table_enabled=${hpos}`);
  const sql =
    hpos === 'yes'
      ? `SELECT id, status, total_amount, currency, payment_method, date_paid_gmt FROM wp_wc_orders WHERE id = ${order.id}`
      : `SELECT ID, post_type, post_status FROM wp_posts WHERE ID = ${order.id}`;
  try {
    const row = wpCli(['db', 'query', sql, '--skip-column-names']);
    evidence.push(`  raw storage row: ${row.replace(/\t/g, ' | ').replace(/\n/g, ' ')}`);
  } catch (err) {
    evidence.push(`  raw storage read failed: ${trunc(err.message, 160)}`);
  }

  // Fourth witness: what a human sees on the orders screen in wp-admin.
  try {
    let admin = await http(`${SHOP_HTTP}/wp-admin/admin.php?page=wc-orders`, {
      headers: { cookie: jar.header() },
    });
    if (admin.status >= 300 && admin.status < 400 && admin.headers.location) {
      admin = await http(new URL(admin.headers.location, SHOP_HTTP).toString(), {
        headers: { cookie: jar.header() },
      });
    }
    const listed = new RegExp(`#\\s*${order.id}\\b`).test(admin.body);
    const statusShown =
      (admin.body.match(
        new RegExp(`#\\s*${order.id}\\b[\\s\\S]{0,1500}?order-status[^>]*status-([a-z-]+)`, 'i')
      ) ||
        admin.body.match(
          new RegExp(`order-status[^>]*status-([a-z-]+)[\\s\\S]{0,1500}?#\\s*${order.id}\\b`, 'i')
        ) ||
        [])[1] ?? null;
    evidence.push(
      `  wp-admin orders screen -> ${admin.status}; order #${order.id} listed: ${listed}; status class shown: ${
        statusShown ?? 'not parsed'
      }`
    );
  } catch (err) {
    evidence.push(`  wp-admin orders screen unreadable: ${trunc(err.message, 160)}`);
  }

  // And what it did about mail.
  const mailAfter = readJsonl('mail.jsonl').slice(mailBefore);
  if (!mailAfter.length) {
    evidence.push('  mail: nothing attempted');
  } else {
    for (const m of mailAfter) {
      evidence.push(
        `  mail ${m.event}: to=${JSON.stringify(m.to)} subject=${JSON.stringify(
          m.subject
        )}${m.reason ? ` reason=${trunc(m.reason, 120)}` : ''}`
      );
    }
  }

  // "Paid" for WooCommerce is a status the shop treats as settled plus a
  // date_paid it stamped itself. Both, or it is not an answer of yes.
  const paidStatuses = ['processing', 'completed'];
  evidence.push(
    `  verdict inputs: status=${order.status} (paid-side statuses: ${paidStatuses.join(
      ', '
    )}), date_paid=${order.date_paid ?? 'null'}`
  );
  return paidStatuses.includes(order.status) && order.date_paid ? 'PASS' : 'FAIL';
}

// ------------------------------------------------------------------ main

async function main() {
  if (!existsSync(SHOP_CA) || !existsSync(CALLBACK_CA)) {
    console.error('Certificates are missing. Run ./setup.sh first.');
    process.exit(2);
  }
  clearInstrument();

  const results = [];
  let keys = null;
  let jar = null;

  const run = async (title, fn) => {
    const evidence = [];
    let verdict;
    try {
      verdict = await fn(evidence);
    } catch (err) {
      verdict = err instanceof Blocked ? `BLOCKED(${err.message})` : `BLOCKED(${err.message})`;
      if (!(err instanceof Blocked)) evidence.push(`  unexpected: ${err.stack?.split('\n')[0]}`);
    }
    results.push({ title, verdict, evidence });
  };

  const session = await login();
  jar = session.jar;

  await run('1. wc-auth one-click key grant', async (ev) => {
    const out = await probeWcAuth(ev, session);
    keys = out.keys;
    return out.verdict;
  });

  await run('2. Store API without authentication', (ev) => probeStoreApi(ev));

  await run('3. Paid order created from outside', (ev) => probeOrder(ev, keys, jar));

  console.log('');
  console.log('================ WooCommerce integration probes ================');
  console.log(`shop ${SHOP_HTTP} / ${SHOP_HTTPS}`);
  try {
    console.log(
      `stack ${wpCli(['core', 'version']).trim()} WordPress, WooCommerce ${wpCli([
        'plugin',
        'get',
        'woocommerce',
        '--field=version',
      ]).trim()}`
    );
  } catch {
    console.log('stack could not be read');
  }
  for (const r of results) {
    console.log('');
    console.log(`--- ${r.title}`);
    console.log(`    VERDICT: ${r.verdict}`);
    for (const line of r.evidence) console.log(`      ${line}`);
  }
  console.log('');

  const blocked = results.filter((r) => r.verdict.startsWith('BLOCKED'));
  if (blocked.length) {
    console.log(`${blocked.length} probe(s) could not answer.`);
    process.exit(1);
  }
  console.log(results.map((r) => r.verdict).join(' / '));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
