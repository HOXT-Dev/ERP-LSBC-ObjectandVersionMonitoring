/*
 * Dev-tool Object Sync — unattended runner for GitHub Actions.
 *
 * Reads Objects / Object ID / Description / Version out of PRIVATE AL
 * source repos (same GitHub org, different repos from this one) for four
 * sources — Dev-tool, APIs, Cloud-Enhancements, OnPrem-Enhancements —
 * and writes the results into dev-tool-data.json at this repo's root.
 *
 * Runs server-side so the AL_SOURCE_PAT secret below (which needs read
 * access to those other, private repos) never has to sit in browser
 * JavaScript. The app's browser tab only ever reads the *output* file,
 * dev-tool-data.json, via a plain unauthenticated fetch — it never talks
 * to the AL source repos directly.
 *
 * Required repo secret (Settings > Secrets and variables > Actions):
 *   AL_SOURCE_PAT   A GitHub PAT with Contents: Read and write, scoped to
 *                   the AL source repo(s) used by the sources below.
 *                   (Read-only is enough for reading objects, but "Add
 *                   Object for Monitoring" also needs write access to
 *                   create the new .al files.)
 *
 * dev-tool-data.json's "sources" object (owner/repo/branch/folder per
 * key) is edited from the app itself (Settings > Dev-tool Sync) and
 * committed here before this script ever runs — this script only fills
 * in version / objects / lastSyncedAt for each source, using whatever
 * owner/repo/branch/folder is already on record for it.
 */

const AL_SOURCE_PAT = process.env.AL_SOURCE_PAT;
const fs = require('fs');
const path = require('path');
const DATA_FILE = path.join(process.cwd(), 'dev-tool-data.json');

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

async function ghApi(owner, repo, apiPath) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}${apiPath}`, {
    headers: { 'Authorization': `Bearer ${AL_SOURCE_PAT}`, 'Accept': 'application/vnd.github+json' },
  });
  const body = await res.json().catch(()=>null);
  if (!res.ok) throw new Error((body && body.message) || `GitHub API error (HTTP ${res.status})`);
  return body;
}
function decodeB64Utf8(b64) { return Buffer.from(b64.replace(/\n/g, ''), 'base64').toString('utf8'); }

const AL_OBJECT_RE = /^\s*(table|tableextension|page|pageextension|pagecustomization|report|reportextension|codeunit|query|xmlport|enum|enumextension|permissionset|permissionsetextension|profile|controladdin|interface)\s+(\d+)\s+"?([^"\r\n{]+?)"?\s*(\{|extends)/gim;
function parseAlObjects(text) {
  const out = []; let m; AL_OBJECT_RE.lastIndex = 0;
  while ((m = AL_OBJECT_RE.exec(text))) out.push({ type: m[1].toLowerCase(), id: Number(m[2]), name: m[3].trim() });
  return out;
}

function encPath(p) { return p.split('/').map(encodeURIComponent).join('/'); }

// One commit -> { summary, details, author, date }. Merge commits are dropped
// (a "Merge pull request" keeps its PR title, which git stores in the body).
function commitInfo(c) {
  var msg = ((c.commit && c.commit.message) || '').replace(/\r/g, '');
  var lines = msg.split('\n');
  var summary = (lines[0] || '').trim();
  var details = lines.slice(1).join('\n').trim();
  if (/^Merge (branch|remote-tracking)/i.test(summary)) return null;
  if (/^Merge pull request/i.test(summary) && details) {
    var dl = details.split('\n');
    summary = (dl[0] || '').trim();
    details = dl.slice(1).join('\n').trim();
  }
  if (!summary) return null;
  var who = (c.commit && c.commit.author && c.commit.author.name) || '';
  var when = (c.commit && c.commit.committer && c.commit.committer.date) || (c.commit && c.commit.author && c.commit.author.date) || '';
  return { sha: c.sha, summary: summary.slice(0, 200), details: details.slice(0, 600), author: who, date: when };
}

// Release notes straight from git history. For each app: find the commits that
// touched its app.json (each one is a possible version bump), read the version
// out of app.json as it was at that commit, then hand every commit between one
// bump and the next to the version that bump introduced — so 0.0.0.1 and
// 0.0.0.2 each list exactly the changes deployed in them, with their commit
// messages. Commits after the latest bump are not released yet and are left out.
async function buildAutoNotes(cfg, apps) {
  var owner = cfg.owner, repo = cfg.repo, branch = cfg.branch || 'main';
  var cache = Object.assign({}, cfg.versionCache || {}); // commit sha -> version (commits never change, so this is safe to keep)
  var groups = [];
  for (var ai = 0; ai < apps.length; ai++) {
    var app = apps[ai];
    var jsonPath = app.dir ? app.dir + '/app.json' : 'app.json';
    var bumps = await ghApi(owner, repo, '/commits?sha=' + encodeURIComponent(branch) + '&path=' + encPath(jsonPath) + '&per_page=60');
    if (!Array.isArray(bumps) || !bumps.length) continue;
    var truncated = bumps.length >= 60; // more bumps exist than we fetched
    var oldestBump = bumps[bumps.length - 1].sha;
    var bumpShas = {};
    bumps.forEach(function (b) { bumpShas[b.sha] = true; });

    var history = [];
    for (var page = 1; page <= 5; page++) {
      var batch = await ghApi(owner, repo, '/commits?sha=' + encodeURIComponent(branch) + (app.dir ? '&path=' + encPath(app.dir) : '') + '&per_page=100&page=' + page);
      if (!Array.isArray(batch) || !batch.length) break;
      history = history.concat(batch);
      if (batch.length < 100) break;
    }
    if (truncated) {
      var cut = history.findIndex(function (c) { return c.sha === oldestBump; });
      if (cut >= 0) history = history.slice(0, cut + 1);
    }
    history.reverse(); // oldest first

    for (var i = 0; i < history.length; i++) {
      var hc = history[i];
      if (bumpShas[hc.sha] && cache[hc.sha] === undefined) {
        try {
          var f = await ghApi(owner, repo, '/contents/' + encPath(jsonPath) + '?ref=' + hc.sha);
          var j = JSON.parse(decodeB64Utf8(f.content).replace(/^\uFEFF/, ''));
          cache[hc.sha] = j.version || '';
        } catch (_) { cache[hc.sha] = ''; }
      }
    }

    var pending = [];
    for (var k = 0; k < history.length; k++) {
      var c = history[k];
      var info = commitInfo(c);
      if (info) pending.push(info);
      if (bumpShas[c.sha] && cache[c.sha]) {
        if (!(truncated && c.sha === oldestBump)) { // that oldest group would be missing its earlier commits, so skip it
          groups.push({
            id: c.sha, version: cache[c.sha], appName: app.name || '',
            date: (info && info.date) || ((c.commit && c.commit.committer && c.commit.committer.date) || ''),
            commits: pending.slice().reverse().slice(0, 30), // newest first
          });
        }
        pending = [];
      }
    }
  }
  // the same app + version bumped twice (say a dependency edit) reads as one release
  var byKey = {}, order = [];
  groups.forEach(function (g) {
    var key = g.appName + '|' + g.version;
    if (!byKey[key]) { byKey[key] = g; order.push(key); }
    else {
      var ex = byKey[key];
      ex.commits = g.commits.concat(ex.commits).slice(0, 30);
      if (g.date > ex.date) { ex.date = g.date; ex.id = g.id; }
    }
  });
  var out = order.map(function (key) { return byKey[key]; });
  out.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
  return { notes: out.slice(0, 20), cache: cache };
}

async function ghApiPut(owner, repo, apiPath, bodyObj) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}${apiPath}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${AL_SOURCE_PAT}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj),
  });
  const body = await res.json().catch(()=>null);
  if (!res.ok) throw new Error((body && body.message) || `GitHub API error (HTTP ${res.status})`);
  return body;
}
function encodeB64Utf8(text) { return Buffer.from(text, 'utf8').toString('base64'); }

// <ObjectName>.<Suffix>.al inside a /<TypeFolder>/ subfolder — matches the
// "Add Object for Monitoring" form in the app exactly (same two tables).
const AL_TYPE_FOLDER = {
  table:'Tables', page:'Pages', report:'Reports', codeunit:'Codeunits', query:'Queries', xmlport:'XMLports', enum:'Enums',
  tableextension:'TableExtensions', pageextension:'PageExtensions', reportextension:'ReportExtensions', enumextension:'EnumExtensions',
  permissionset:'PermissionSets', permissionsetextension:'PermissionSetExtensions',
  interface:'Interfaces', profile:'Profiles', controladdin:'ControlAddIns', pagecustomization:'PageCustomizations',
};
const AL_TYPE_FILESUFFIX = {
  table:'Table', page:'Page', report:'Report', codeunit:'Codeunit', query:'Query', xmlport:'XMLport', enum:'Enum',
  tableextension:'TableExtension', pageextension:'PageExtension', reportextension:'ReportExtension', enumextension:'EnumExtension',
  permissionset:'PermissionSet', permissionsetextension:'PermissionSetExtension',
  interface:'Interface', profile:'Profile', controladdin:'ControlAddIn', pagecustomization:'PageCustomization',
};

// House style confirmed from real examples (Table/Page/Codeunit). Everything
// else is a minimal, standard, compiling AL skeleton — not house style, since
// no example was given for those types yet.
function alSkeleton(p, version) {
  const v = version || '0.0.0.0';
  const decl = (kw, extra) => `${kw} ${p.objectId} "${p.name}"${p.extends ? ` extends "${p.extends}"` : ''} //${v}${extra || ''}`;
  switch (p.objectType) {
    case 'table':
      return `table ${p.objectId} "${p.name}" //${v}\n{\n    DataClassification = CustomerContent;\n\n    fields\n    {\n        field(1; "No."; Code[20])\n        {\n            DataClassification = CustomerContent;\n        }\n    }\n    keys\n    {\n        key(PK; "No.")\n        {\n            Clustered = true;\n        }\n    }\n}\n`;
    case 'page':
      return `page ${p.objectId} "${p.name}" //${v}\n{\n    ApplicationArea = All;\n    Caption = '${p.name}';\n    PageType = List;\n    SourceTable = "${p.sourceTable}";\n    UsageCategory = Administration;\n\n    layout\n    {\n        area(Content)\n        {\n            repeater("Group")\n            {\n            }\n        }\n    }\n}\n`;
    case 'codeunit':
      return `codeunit ${p.objectId} "${p.name}" //${v}\n{\n}\n`;
    case 'report':
      return `report ${p.objectId} "${p.name}" //${v}\n{\n    UsageCategory = ReportsAndAnalysis;\n    ApplicationArea = All;\n\n    dataset\n    {\n    }\n}\n`;
    case 'query':
      return `query ${p.objectId} "${p.name}" //${v}\n{\n    QueryType = Normal;\n\n    elements\n    {\n    }\n}\n`;
    case 'xmlport':
      return `xmlport ${p.objectId} "${p.name}" //${v}\n{\n    Direction = Export;\n\n    schema\n    {\n    }\n}\n`;
    case 'enum':
      return `enum ${p.objectId} "${p.name}" //${v}\n{\n    Extensible = true;\n\n    value(0; None)\n    {\n    }\n}\n`;
    case 'tableextension':
      return `${decl('tableextension')}\n{\n    fields\n    {\n    }\n}\n`;
    case 'pageextension':
      return `${decl('pageextension')}\n{\n    layout\n    {\n    }\n}\n`;
    case 'reportextension':
      return `${decl('reportextension')}\n{\n}\n`;
    case 'enumextension':
      return `${decl('enumextension')}\n{\n}\n`;
    case 'permissionset':
      return `permissionset ${p.objectId} "${p.name}" //${v}\n{\n    Assignable = true;\n\n    Permissions = ;\n}\n`;
    case 'permissionsetextension':
      return `${decl('permissionsetextension')}\n{\n    Permissions = ;\n}\n`;
    case 'interface':
      return `interface "${p.name}" //${v}\n{\n}\n`;
    case 'profile':
      return `profile "${p.name}" //${v}\n{\n    Caption = '${p.name}';\n}\n`;
    case 'controladdin':
      return `controladdin "${p.name}" //${v}\n{\n}\n`;
    case 'pagecustomization':
      return `pagecustomization "${p.name}" customizes "${p.extends}" //${v}\n{\n    layout\n    {\n    }\n    actions\n    {\n    }\n}\n`;
    default:
      return `${p.objectType} ${p.objectId ? p.objectId + ' ' : ''}"${p.name}" //${v}\n{\n}\n`;
  }
}

// Creates every still-pending object's .al file in the AL source repo (NOT
// this repo), using AL_SOURCE_PAT — which needs Contents: Read AND WRITE for
// this to work, unlike the read-only sync above. Runs before the normal
// read-sync for that source, so a newly created object shows up as a real
// discovered object in the SAME run. Non-destructive: only ever creates a
// file at a brand-new path — if something is already there, the request is
// marked failed rather than silently overwritten.
async function createPendingObjects(key, cfg) {
  const pending = (cfg.pendingObjects || []).filter(p => p.status === 'pending');
  if (!pending.length) return cfg;
  for (const p of pending) {
    try {
      const typeFolder = AL_TYPE_FOLDER[p.objectType] || cap1(p.objectType);
      const suffix = AL_TYPE_FILESUFFIX[p.objectType] || cap1(p.objectType);
      const safeName = p.name.replace(/[\\/:*?"<>|]/g, '');
      const path = [p.folderPath, typeFolder, `${safeName}.${suffix}.al`].filter(Boolean).join('/');
      let exists = null;
      try { exists = await ghApi(cfg.owner, cfg.repo, `/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(cfg.branch || 'main')}`); } catch (e) { /* 404 = good, path is free */ }
      if (exists) throw new Error(`${path} already exists in the repo — not overwriting it.`);
      const content = alSkeleton(p, cfg.version);
      await ghApiPut(cfg.owner, cfg.repo, `/contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
        message: `Add ${p.objectType} ${p.objectId || ''} "${p.name}" (queued by ${p.requestedBy || 'the app'})`.trim(),
        content: encodeB64Utf8(content),
        branch: cfg.branch || 'main',
      });
      p.status = 'done'; p.filePath = path; p.error = '';
      console.log(`[${key}] created ${path}`);
    } catch (err) {
      p.status = 'error'; p.error = err.message;
      console.error(`::warning::${key} could not create object "${p.name}": ${err.message}`);
    }
  }
  // Keep the queue from growing forever — forget old successes, but always keep errors
  // visible until someone clears them (the app's "Remove" button on a non-pending row).
  cfg.pendingObjects = pending.filter(p => p.status !== 'done').concat((cfg.pendingObjects || []).filter(p => !pending.includes(p)));
  return cfg;
}
function cap1(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

async function syncOneSource(key, cfg) {
  if (!cfg.owner || !cfg.repo) { console.log(`[${key}] not configured yet — skipping.`); return cfg; }
  const tree = await ghApi(cfg.owner, cfg.repo, `/git/trees/${encodeURIComponent(cfg.branch || 'main')}?recursive=1`);
  const scoped = (tree.tree || []).filter(e => e.type === 'blob' && (!cfg.folder || e.path === cfg.folder || e.path.startsWith(cfg.folder + '/')));
  const entries = scoped.filter(e => e.path.endsWith('.al') || /(^|\/)app\.json$/.test(e.path));
  const apps = []; // every app.json in scope: { dir, name, version }
  const alFiles = []; // { path, text }
  for (const e of entries) {
    const blob = await ghApi(cfg.owner, cfg.repo, `/git/blobs/${e.sha}`);
    const text = decodeB64Utf8(blob.content).replace(/^\uFEFF/, ''); // AL's app.json often starts with a BOM, which JSON.parse rejects
    if (e.path.endsWith('app.json')) {
      try {
        const j = JSON.parse(text);
        apps.push({ dir: e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : '', name: j.name || '', version: j.version || '' });
      } catch (_) {}
    } else alFiles.push({ path: e.path, text });
  }
  // An object belongs to the app whose app.json is the nearest one above its file
  const appFor = p => {
    let best = null;
    for (const a of apps) {
      const inside = a.dir === '' || p === a.dir || p.startsWith(a.dir + '/');
      if (inside && (!best || a.dir.length > best.dir.length)) best = a;
    }
    return best;
  };
  const byKey = {};
  for (const f of alFiles) {
    const app = appFor(f.path);
    for (const o of parseAlObjects(f.text)) {
      byKey[`${o.type}:${o.id}`] = { objectType: o.type, objectId: o.id, description: o.name, appName: app ? app.name : '', appVersion: app ? app.version : '', appDir: app ? app.dir : '' };
    }
  }
  // Release notes from git history. Never fatal: if it fails, the previous notes stay and the reason is recorded.
  var autoNotes = cfg.autoNotes || [], versionCache = cfg.versionCache || {}, notesError = '';
  try {
    var built = await buildAutoNotes(cfg, apps);
    autoNotes = built.notes; versionCache = built.cache;
  } catch (err) {
    notesError = err.message;
    console.error('::warning::' + key + ' release notes failed: ' + err.message);
  }
  console.log('[' + key + '] ' + autoNotes.length + ' release(s) found in git history' + (notesError ? ' (' + notesError + ')' : ''));
  // The source's own "current version" = the app closest to the top of the scanned folder
  const depth = a => a.dir.split('/').filter(Boolean).length;
  const mainApp = apps.slice().sort((a, b) => depth(a) - depth(b))[0] || null;
  console.log(`[${key}] ${cfg.owner}/${cfg.repo}@${cfg.branch || 'main'} — ${Object.keys(byKey).length} object(s) in ${apps.length} app(s)${mainApp && mainApp.version ? `, version ${mainApp.version}` : ''}`);
  return {
    ...cfg, // keeps objectMeta / releaseNotes (entered in the app) and anything else this script doesn't know about
    owner: cfg.owner, repo: cfg.repo, branch: cfg.branch || 'main', folder: cfg.folder || '',
    version: (mainApp && mainApp.version) || cfg.version || null,
    apps: apps.map(a => ({ name: a.name, version: a.version, path: a.dir })),
    objects: Object.values(byKey),
    autoNotes: autoNotes, versionCache: versionCache, notesError: notesError,
    lastSyncedAt: new Date().toISOString(),
  };
}

async function main() {
  if (!AL_SOURCE_PAT) fail('Missing AL_SOURCE_PAT secret.');
  if (!fs.existsSync(DATA_FILE)) fail(`${DATA_FILE} not found — save the connection config from the app first (Settings > Dev-tool Sync > Save Connection).`);
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  data.sources = data.sources || {};
  let lastRunError = '';
  for (const key of Object.keys(data.sources)) {
    try {
      data.sources[key] = await createPendingObjects(key, data.sources[key]);
      data.sources[key] = await syncOneSource(key, data.sources[key]);
    } catch (err) {
      lastRunError += `[${key}] ${err.message}\n`;
      console.error(`::warning::${key} sync failed: ${err.message}`);
    }
  }
  data.lastRunAt = new Date().toISOString();
  data.lastRunStatus = lastRunError ? 'error' : 'success';
  data.lastRunError = lastRunError.trim();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  if (lastRunError) fail(`One or more sources failed:\n${lastRunError}`);
}

main();
