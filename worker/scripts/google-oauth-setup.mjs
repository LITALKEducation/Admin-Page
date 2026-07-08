#!/usr/bin/env node
// One-time helper: gets a Google OAuth refresh token for Google Meet
// auto-creation (see worker/README.md "Google Meet auto-creation").
//
// Run it, open the printed URL, and log into the Google account that
// should own the class calendar. It starts a tiny local server to catch
// the redirect, exchanges the code for tokens, and prints the refresh
// token to store as a Worker secret.
//
// Usage:
//   GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... node scripts/google-oauth-setup.mjs
// or pass them as arguments:
//   node scripts/google-oauth-setup.mjs <clientId> <clientSecret>

import http from 'node:http';
import readline from 'node:readline';

const PORT = 53682; // arbitrary; must match a redirect URI Google will accept for a "Desktop app" OAuth client (loopback IPs are always allowed).
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); }));
}

async function main() {
  const clientId = process.argv[2] || process.env.GOOGLE_OAUTH_CLIENT_ID || (await ask('Google OAuth Client ID: '));
  const clientSecret = process.argv[3] || process.env.GOOGLE_OAUTH_CLIENT_SECRET || (await ask('Google OAuth Client Secret: '));
  if (!clientId || !clientSecret) {
    console.error('Missing client id/secret.');
    process.exit(1);
  }

  const redirectUri = `http://127.0.0.1:${PORT}`;
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPE);
  authUrl.searchParams.set('access_type', 'offline'); // required to get a refresh token
  authUrl.searchParams.set('prompt', 'consent'); // forces a refresh token even on repeat runs

  console.log('\nOpen this URL and log into the Google account that should own the class calendar:\n');
  console.log(authUrl.toString());
  console.log('\nWaiting for you to approve access...\n');

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, redirectUri);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(error
        ? `<p>Authorization failed: ${error}. You can close this window and try again.</p>`
        : '<p>Authorized — you can close this window and go back to the terminal.</p>');
      server.close();
      if (error) reject(new Error(error));
      else if (code) resolve(code);
      else reject(new Error('No code in redirect'));
    });
    server.listen(PORT, '127.0.0.1');
  });

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const tokenJson = await tokenRes.json();
  if (!tokenRes.ok || !tokenJson.refresh_token) {
    console.error('\nToken exchange failed:', tokenJson.error_description || tokenJson.error || tokenRes.status);
    if (tokenJson.error === 'invalid_grant') console.error('(the code may have expired — re-run this script)');
    process.exit(1);
  }

  console.log('\nSuccess! Store these as Worker secrets:\n');
  console.log('  npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID');
  console.log(`    -> ${clientId}`);
  console.log('  npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET');
  console.log(`    -> ${clientSecret}`);
  console.log('  npx wrangler secret put GOOGLE_OAUTH_REFRESH_TOKEN');
  console.log(`    -> ${tokenJson.refresh_token}`);
  console.log('\n(Keep the refresh token secret — it grants Calendar access to this account indefinitely.)');
}

main().catch((err) => {
  console.error('\nFailed:', err.message || err);
  process.exit(1);
});
