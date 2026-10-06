/*
 * BC Extension Snapshot — unattended runner for GitHub Actions.
 *
 * Runs the same logic as "Run Sync Now" inside the app (viewExtMgmt /
 * runExtensionSnapshot in index.html), but from GitHub's own servers on a
 * cron schedule, so it fires whether or not anyone has the app open.
 *
 * STORAGE: unlike the rest of this app (Projects, Tickets, Store
 * Customization, Users, general Settings — all in the shared SharePoint
 * database file), Extension Management Comparison data lives in THIS
 * REPO, in extmgmt-data.json at the repo root. That file holds both the
 * connection settings (tenant/client IDs, environments, company IDs,
 * retention) and the rolling window of snapshots.
 *
 * Because this workflow already has the repo checked out (actions/checkout),
 * it reads and writes extmgmt-data.json as a normal local file — no
 * Microsoft Graph calls, no SharePoint app registration, no extra secrets
 * beyond the Business Central ones below. The workflow step after this
 * script runs commits the updated file with git, using the automatic
 * GITHUB_TOKEN (requires `permissions: contents: write` in the workflow).
 *
 * Required repo secrets (Settings > Secrets and variables > Actions):
 *   BC_TENANT_ID       Azure AD tenant (directory) ID
 *   BC_CLIENT_ID       Azure AD app registration (client) ID — Business Central only
 *   BC_CLIENT_SECRET   Client secret value for that app registration
 *
 * That app registration needs Business Central API access — either:
 *   (a) Custom API mode (default): normal BC user permissions in each
 *       environment for the deployed AL extension's API (publisher/
 *       group/version and each environment's Company ID come from
 *       extmgmt-data.json itself), or
 *   (b) Admin Center API mode: BC Admin Center / Global Admin role,
 *       if settings.apiMode is set to "admin" in extmgmt-data.json
 */

const BC_TENANT_ID = process.env.BC_TENANT_ID;
const BC_CLIENT_ID = process.env.BC_CLIENT_ID;
const BC_CLIENT_SECRET = process.env.BC_CLIENT_SECRET;

const fs = require('fs');
const path = require('path');
const DATA_FILE = path.join(process.cwd(), 'extmgmt-data.json');

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

async function getToken(tenantId, clientId, clientSecret, scope) {
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || `Token request failed (HTTP ${res.status}) for scope ${scope}`);
  return data.access_token;
}

async function fetchBcExtensions(bcToken, env, settings) {
  let url;
  if (settings.apiMode === 'admin') {
    url = `https://api.businesscentral.dynamics.com/admin/v2.18/applications/businesscentral/environments/${encodeURIComponent(env.name)}/extensions`;
  } else {
    if (!settings.apiPublisher || !settings.apiGroup) throw new Error('Missing API Publisher/Group in extmgmt-data.json for custom API mode.');
    if (!env.companyId) throw new Error('Missing Company ID for this environment (required for custom API mode).');
    url = `https://api.businesscentral.dynamics.com/v2.0/${encodeURIComponent(settings.tenantId)}/${encodeURIComponent(env.name)}/api/${encodeURIComponent(settings.apiPublisher)}/${encodeURIComponent(settings.apiGroup)}/${encodeURIComponent(settings.apiVersion || 'v2.0')}/companies(${env.companyId})/installedExtensions`;
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${bcToken}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || `HTTP ${res.status}`);
  return (data.value || []).map((e) => ({
    id: e.id || e.appId || e.name,
    name: e.displayName || e.name || 'Unnamed extension',
    publisher: e.publisher || '',
    version: e.version || [e.versionMajor, e.versionMinor, e.versionBuild, e.versionRevision].filter((v) => v != null).join('.'),
    state: e.state || (e.installed === false ? 'not installed' : 'installed'),
  }));
}

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    fail('extmgmt-data.json not found in the repo yet — save the connection once from the app (Settings > Extension Management) so it can be created first.');
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function pruneSnapshots(data) {
  const days = (data.settings && data.settings.retentionDays) || 35;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  data.snapshots = (data.snapshots || []).filter((s) => new Date(s.timestamp).getTime() >= cutoff);
}

async function main() {
  if (!BC_TENANT_ID || !BC_CLIENT_ID || !BC_CLIENT_SECRET) {
    fail('Missing BC_TENANT_ID / BC_CLIENT_ID / BC_CLIENT_SECRET repo secrets.');
  }

  console.log('Reading extmgmt-data.json from the repo...');
  const data = loadData();
  data.settings = data.settings || {};
  data.snapshots = data.snapshots || [];

  const environments = (data.settings.environments || []).filter((e) => e.name);
  if (!environments.length) {
    fail('No environments configured. Add at least one environment in the app\'s Settings > Extension Management page first.');
  }

  console.log('Requesting Business Central token...');
  const bcToken = await getToken(BC_TENANT_ID, BC_CLIENT_ID, BC_CLIENT_SECRET, 'https://api.businesscentral.dynamics.com/.default');

  const results = [];
  for (const env of environments) {
    console.log(`Fetching extensions for ${env.label || env.name}...`);
    try {
      const extensions = await fetchBcExtensions(bcToken, env, data.settings);
      results.push({ envId: env.id, envName: env.name, envLabel: env.label || env.name, envType: env.type, ok: true, extensions });
    } catch (e) {
      console.warn(`  failed: ${e.message}`);
      results.push({ envId: env.id, envName: env.name, envLabel: env.label || env.name, envType: env.type, ok: false, error: e.message, extensions: [] });
    }
  }

  const snapshot = { id: uid(), timestamp: new Date().toISOString(), results };
  data.snapshots.push(snapshot);
  pruneSnapshots(data);

  const anyFailed = results.some((r) => !r.ok);
  data.settings.lastRunAt = snapshot.timestamp;
  data.settings.lastRunStatus = anyFailed ? 'error' : 'success';
  data.settings.lastRunError = anyFailed
    ? results.filter((r) => !r.ok).map((r) => `${r.envLabel}: ${r.error}`).join(' | ')
    : '';

  console.log('Writing extmgmt-data.json...');
  saveData(data);

  console.log(`Captured ${results.filter((r) => r.ok).length}/${results.length} environment(s).`);
  console.log(anyFailed ? 'Done, with some environment errors — see settings.lastRunError.' : 'Done.');
  if (anyFailed) process.exitCode = 1; // marks the Action run visibly failed, without blocking the commit step that saves what did succeed
}

main().catch((e) => fail(e.message || String(e)));
