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

// Declaration line = keyword, numeric id, then a quoted name or one bare identifier. Anything after that on the
// line (a //version comment, "extends X", ...) and where the opening { sits are deliberately ignored.
const AL_OBJECT_RE = /^[ \t]*(table|tableextension|page|pageextension|pagecustomization|report|reportextension|codeunit|query|xmlport|enum|enumextension|permissionset|permissionsetextension|entitlement|profile|controladdin|interface)[ \t]+(\d+)[ \t]+(?:"([^"\r\n]+)"|([^\s"{]+))/gim;
function parseAlObjects(text) {
  const out = []; let m; AL_OBJECT_RE.lastIndex = 0;
  while ((m = AL_OBJECT_RE.exec(text))) out.push({ type: m[1].toLowerCase(), id: Number(m[2]), name: (m[3] || m[4]).trim() });
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

const norm = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
// Every name a type's folder might already go by in a repo: Page / Pages / PageExtension / PageExt ...
function typeFolderNorms(kw) {
  const out = new Set();
  [kw, AL_TYPE_FILESUFFIX[kw], AL_TYPE_FOLDER[kw]].forEach(x => {
    if (!x) return;
    const n = norm(x);
    [n, n.replace('extension', 'ext')].forEach(v => { out.add(v); out.add(v + 's'); });
  });
  return out;
}
// The folder directly inside `base` that this object type already lives in (using the repo's own spelling), or null.
function findTypeFolder(dirs, base, kw) {
  const prefix = base ? base + '/' : '';
  const names = typeFolderNorms(kw);
  const kids = dirs.filter(d => d.length > prefix.length && d.startsWith(prefix) && !d.slice(prefix.length).includes('/')).map(d => d.slice(prefix.length));
  return kids.find(k => names.has(norm(k))) || null;
}
async function listBranches(owner, repo) {
  const names = [];
  for (let page = 1; page <= 5; page++) {
    const list = await ghApi(owner, repo, '/branches?per_page=100&page=' + page);
    list.forEach(b => names.push(b.name));
    if (list.length < 100) break;
  }
  return names;
}
async function repoDefaultBranch(cfg) {
  try { const r = await ghApi(cfg.owner, cfg.repo, ''); return (r && r.default_branch) || ''; } catch (e) { return ''; }
}

// Creates every still-pending object's .al file in the AL source repo (NOT
// this repo), using AL_SOURCE_PAT — which needs Contents: Read AND WRITE.
// Rules, enforced here no matter what the browser sent:
//  - never on main/master or the repo's default branch — only on the branch the person picked
//  - goes into the type folder that ALREADY exists inside the target folder (Page, Pages, ...),
//    using the repo's own spelling; it only creates a folder if the person said yes (createFolder)
//  - never overwrites: if something is already at that path, the request fails instead
// Runs before the normal read-sync for that source.
async function createPendingObjects(key, cfg) {
  const pending = (cfg.pendingObjects || []).filter(p => p.status === 'pending');
  if (!pending.length) return cfg;
  const blocked = new Set(['main', 'master']);
  const def = await repoDefaultBranch(cfg);
  if (def) blocked.add(def);
  const dirsByBranch = {}; // branch -> directory paths, read once per branch per run
  for (const p of pending) {
    try {
      const branch = p.branch;
      if (!branch) throw new Error('No branch was chosen for this object — remove it and add it again, picking a branch.');
      if (blocked.has(branch)) throw new Error(`Creating files directly on "${branch}" is not allowed — pick a different branch.`);
      if (!dirsByBranch[branch]) {
        let t;
        try { t = await ghApi(cfg.owner, cfg.repo, `/git/trees/${encodeURIComponent(branch)}?recursive=1`); }
        catch (e) { throw new Error(`Branch "${branch}" could not be read (${e.message}).`); }
        dirsByBranch[branch] = (t.tree || []).filter(e => e.type === 'tree').map(e => e.path);
      }
      const base = (p.folderPath || '').replace(/\/+$/, '');
      let folder = findTypeFolder(dirsByBranch[branch], base, p.objectType);
      const folderExisted = !!folder;
      if (!folder) {
        if (!p.createFolder) {
          p.status = 'needs-folder';
          p.error = `There is no folder for ${p.objectType} objects in "${base || '(repo root)'}" on branch "${branch}".`;
          console.log(`[${key}] "${p.name}" is waiting for an answer: no ${p.objectType} folder in ${base || '(repo root)'} on ${branch}`);
          continue;
        }
        folder = p.newFolderName || AL_TYPE_FOLDER[p.objectType] || cap1(p.objectType);
      }
      const suffix = AL_TYPE_FILESUFFIX[p.objectType] || cap1(p.objectType);
      const safeName = p.name.replace(/[\\/:*?"<>|]/g, '');
      const path = [base, folder, `${safeName}.${suffix}.al`].filter(Boolean).join('/');
      const encPath = path.split('/').map(encodeURIComponent).join('/');
      let exists = null;
      try { exists = await ghApi(cfg.owner, cfg.repo, `/contents/${encPath}?ref=${encodeURIComponent(branch)}`); } catch (e) { /* 404 = the path is free */ }
      if (exists) throw new Error(`${path} already exists on "${branch}" — not overwriting it.`);
      await ghApiPut(cfg.owner, cfg.repo, `/contents/${encPath}`, {
        message: `Add ${p.objectType} ${p.objectId || ''} "${p.name}" (queued by ${p.requestedBy || 'the app'})`.replace(/\s+/g, ' ').trim(),
        content: encodeB64Utf8(alSkeleton(p, cfg.version)),
        branch,
      });
      if (!folderExisted) dirsByBranch[branch].push(base ? `${base}/${folder}` : folder); // later requests in this run see it
      p.status = 'done'; p.filePath = path; p.error = ''; p.doneAt = new Date().toISOString();
      p.url = `https://github.com/${cfg.owner}/${cfg.repo}/blob/${encodeURIComponent(branch)}/${encPath}`;
      console.log(`[${key}] created ${path} on branch ${branch}${folderExisted ? '' : ' (new folder)'}`);
    } catch (err) {
      p.status = 'error'; p.error = err.message;
      console.error(`::warning::${key} could not create object "${p.name}": ${err.message}`);
    }
  }
  return cfg;
}
// Created objects live on a feature branch until it's merged, so they stay listed here (and keep their ID reserved).
// Once the read-sync of the main branch actually sees one, it's dropped; otherwise only the 20 newest are kept.
function prunePending(cfg) {
  const have = new Set((cfg.objects || []).map(o => `${o.objectType}:${o.objectId}`));
  const list = (cfg.pendingObjects || []).filter(p => !(p.status === 'done' && p.objectId != null && have.has(`${p.objectType}:${p.objectId}`)));
  const keep = new Set(list.filter(p => p.status === 'done').sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || '')).slice(0, 20));
  cfg.pendingObjects = list.filter(p => p.status !== 'done' || keep.has(p));
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
  const unparsed = []; // .al files that yielded no recognisable object declaration
  const dupes = [];    // a type+ID declared by more than one file (only one can be listed)
  let filesWithObjects = 0;
  for (const f of alFiles) {
    const app = appFor(f.path);
    const fileDir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    const found = parseAlObjects(f.text);
    if (!found.length) {
      const firstLines = f.text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, 2).join(' | ').slice(0, 160);
      unparsed.push({ path: f.path, firstLines });
    } else filesWithObjects++;
    for (const o of found) {
      const k = `${o.type}:${o.id}`;
      if (byKey[k]) dupes.push({ key: k, kept: byKey[k].filePath, other: f.path });
      byKey[k] = { objectType: o.type, objectId: o.id, description: o.name, appName: app ? app.name : '', appVersion: app ? app.version : '', appDir: app ? app.dir : '', fileDir, filePath: f.path };
    }
  }
  const truncated = !!tree.truncated;
  console.log(`[${key}] scanned ${alFiles.length} .al file(s): ${filesWithObjects} with objects, ${unparsed.length} without${dupes.length ? `, ${dupes.length} duplicate type+ID` : ''}`);
  unparsed.slice(0, 15).forEach(u => console.log(`[${key}]   no object found in ${u.path}  →  ${u.firstLines}`));
  dupes.slice(0, 10).forEach(d => console.log(`[${key}]   duplicate ${d.key}: ${d.kept} and ${d.other}`));
  if (truncated) console.log(`::warning::${key}: GitHub truncated the repo file list (too large) — some files were never scanned.`);
  // Branches (for the "Add Object" branch picker) and which folders exist (so the app can tell whether a type folder is there already).
  let branches = null, branchesError = '';
  try { branches = await listBranches(cfg.owner, cfg.repo); } catch (e) { branchesError = e.message; console.log(`[${key}] could not list branches: ${e.message}`); }
  const defaultBranch = await repoDefaultBranch(cfg);
  const repoFolders = (tree.tree || []).filter(e => e.type === 'tree').map(e => e.path)
    .filter(d => { const segs = d.split('/'); return segs.length <= 5 && !segs.some(sg => sg.startsWith('.')) && !segs.includes('node_modules'); }).slice(0, 3000);
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
    branches: branches, branchesError: branchesError, defaultBranch: defaultBranch, repoFolders: repoFolders,
    scanInfo: { alFiles: alFiles.length, withObjects: filesWithObjects, unparsed: unparsed.slice(0, 60), unparsedTotal: unparsed.length, dupes: dupes.slice(0, 60), dupesTotal: dupes.length, truncated: truncated },
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
      data.sources[key] = prunePending(data.sources[key]);
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
