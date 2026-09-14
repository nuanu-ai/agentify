// The receiver WooCommerce POSTs the granted key pair to.
//
// It exists to answer one question: does the wc-auth grant actually deliver a
// working consumer_key/consumer_secret to a third party? So it does the least
// possible — accepts one POST, writes the body to a file the probe reads, and
// answers 200. Everything else is a 404 so a stray request cannot be mistaken
// for a grant.
import { createServer } from 'node:https';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const OUT_DIR = '/var/callback';
const OUT_FILE = `${OUT_DIR}/received.json`;
const LOG_FILE = `${OUT_DIR}/requests.log`;

mkdirSync(OUT_DIR, { recursive: true });

const options = {
  key: readFileSync('/var/certs/callback-key.pem'),
  cert: readFileSync('/var/certs/callback-cert.pem'),
};

function appendLog(line) {
  try {
    const prev = (() => {
      try {
        return readFileSync(LOG_FILE, 'utf8');
      } catch {
        return '';
      }
    })();
    writeFileSync(LOG_FILE, prev + line + '\n');
  } catch (err) {
    console.error('log write failed', err);
  }
}

createServer(options, (req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const stamp = new Date().toISOString();
    appendLog(
      JSON.stringify({
        at: stamp,
        method: req.method,
        url: req.url,
        contentType: req.headers['content-type'] ?? null,
        userAgent: req.headers['user-agent'] ?? null,
        bodyBytes: body.length,
      })
    );
    console.log(`${stamp} ${req.method} ${req.url} ${body.length}B`);

    if (req.method === 'POST' && req.url.startsWith('/wc-auth-callback')) {
      writeFileSync(
        OUT_FILE,
        JSON.stringify(
          { at: stamp, headers: req.headers, raw: body },
          null,
          2
        )
      );
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/health')) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
}).listen(443, '0.0.0.0', () => {
  // 443 and not something higher: wp_http_validate_url only lets WordPress
  // reach ports 80, 443 and 8080, and wc-auth posts through
  // wp_safe_remote_post.
  console.log('callback receiver listening on https://0.0.0.0:443');
});
