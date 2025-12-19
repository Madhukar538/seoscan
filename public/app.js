async function postJson(url, body){
  const res = await fetch(url, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if (!res.ok) throw new Error('Server error: '+res.status);
  return res.json();
}

const clearBtn = document.getElementById('clear');
const statusEl = document.getElementById('status');
const resultsTable = document.getElementById('results');
const tbody = resultsTable.querySelector('tbody');
const exportControls = document.getElementById('export-controls');
const exportFilterEl = document.getElementById('exportFilter');
const exportBtn = document.getElementById('exportCsv');
const sitemapUrlEl = document.getElementById('sitemapUrl');
const loadSitemapBtn = document.getElementById('loadSitemap');
const sitemapLoader = document.getElementById('sitemapLoader');
const urlCountEl = document.getElementById('urlCount');
const sitemapLabelEl = document.getElementById('sitemapLabel');
const modeSiteEl = document.getElementById('modeSite');
const modeSitemapEl = document.getElementById('modeSitemap');
const statusBarEl = document.getElementById('statusBar');
const statusFillEl = statusBarEl ? statusBarEl.querySelector('.status-fill') : null;
const siteBadgeEl = document.getElementById('siteBadge');
const faviconEl = document.getElementById('favicon');
const siteHostEl = document.getElementById('siteHost');
const summaryEl = document.getElementById('summary');
const sumTotalEl = document.getElementById('sumTotal');
const sumH1El = document.getElementById('sumH1');
const sumMissingH1El = document.getElementById('sumMissingH1');
const sumMultipleH1El = document.getElementById('sumMultipleH1');
const sumTimeEl = document.getElementById('sumTime');
const sum200El = document.getElementById('sum200');
const sum4xxEl = document.getElementById('sum4xx');
const sum5xxEl = document.getElementById('sum5xx');
const statusPieEl = document.getElementById('statusPie');
const resultsToggle = document.getElementById('resultsToggle');
const resultsPanel = document.getElementById('resultsPanel');

let lastResults = [];
let sitemapSource = null;
let checkSource = null;
let checkJobId = null;
let resultsCollapsed = false;
let loadedUrls = [];
const defaultConcurrency = 10;
let checkStartTs = null;
let checkTimerId = null;

clearBtn.addEventListener('click', ()=>{
  if (checkSource) {
    checkSource.close();
    checkSource = null;
  }
  cancelCheckJob();
  if (sitemapSource) {
    sitemapSource.close();
    sitemapSource = null;
  }
  sitemapUrlEl.value='';
  if (sitemapLabelEl) syncInputMode();
  sitemapLoader.classList.add('hidden');
  loadSitemapBtn.disabled = false;
  resetResults();
  loadedUrls = [];
  urlCountEl.textContent = '0';
  setStatus('');
  hideFavicon();
});

resultsToggle.addEventListener('click', () => {
  resultsCollapsed = !resultsCollapsed;
  setResultsPanelVisible(!resultsCollapsed);
});

loadSitemapBtn.addEventListener('click', () => {
  const baseUrl = sitemapUrlEl.value.trim();
  if (!baseUrl) return alert('Enter a URL');
  if (sitemapSource) {
    sitemapSource.close();
    sitemapSource = null;
  }
  resetResults();
  loadedUrls = [];
  updateUrlCount();
  setStatus('Fetching sitemap...');
  sitemapLoader.classList.remove('hidden');
  loadSitemapBtn.disabled = true;
  const sitemapUrl = getInputMode() === 'site' ? buildSitemapUrl(baseUrl) : normalizeUrl(baseUrl);
  showFavicon(sitemapUrl);

  const streamUrl = `/api/sitemap-stream?url=${encodeURIComponent(sitemapUrl)}`;
  const es = new EventSource(streamUrl);
  sitemapSource = es;
  let finished = false;
  let total = 0;

  const finish = () => {
    if (finished) return;
    finished = true;
    sitemapLoader.classList.add('hidden');
    loadSitemapBtn.disabled = false;
    if (sitemapSource) {
      sitemapSource.close();
      sitemapSource = null;
    }
  };

  es.addEventListener('batch', (evt) => {
    const data = JSON.parse(evt.data || '{}');
    if (Array.isArray(data.urls) && data.urls.length) {
      for (const u of data.urls) loadedUrls.push(u);
      total = typeof data.total === 'number' ? data.total : loadedUrls.length;
      urlCountEl.textContent = String(total);
      setStatus(`Found ${total} URLs...`);
    }
  });

  es.addEventListener('done', (evt) => {
    const data = JSON.parse(evt.data || '{}');
    total = typeof data.total === 'number' ? data.total : loadedUrls.length;
    urlCountEl.textContent = String(total);
    setStatus(`Loaded ${total} URLs. Starting check...`);
    finish();
    startCheck(loadedUrls);
  });

  es.addEventListener('failed', (evt) => {
    const data = JSON.parse(evt.data || '{}');
    setStatus(`Error: ${data.error || 'Sitemap load failed'}`);
    finish();
  });

  es.onerror = () => {
    if (!finished) {
      setStatus('Error: sitemap stream disconnected');
      finish();
    }
  };
});

function renderResults(rows){
  lastResults = Array.isArray(rows) ? rows : [];
  tbody.innerHTML = '';
  for(const r of rows){
    appendResultRow(r);
  }
  updateSummary();
  if (lastResults.length) exportControls.classList.remove('hidden');
}

function escapeHtml(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function setStatus(text, loading){
  if (!text) {
    statusEl.textContent = '';
    resetProgressBar();
    stopElapsedTimer();
    return;
  }
  if (loading) {
    statusEl.innerHTML = `<span>${escapeHtml(text)}</span><span class="status-loader" aria-hidden="true"></span>`;
  } else {
    statusEl.textContent = text;
  }
}

function resetProgressBar(){
  if (!statusBarEl || !statusFillEl) return;
  statusBarEl.classList.add('hidden');
  statusBarEl.setAttribute('aria-hidden', 'true');
  statusBarEl.setAttribute('aria-valuenow', '0');
  statusFillEl.style.width = '0%';
  statusFillEl.textContent = '';
}

function updateProgressBar(processed, total){
  if (!statusBarEl || !statusFillEl) return;
  const safeTotal = Math.max(0, Number(total) || 0);
  if (safeTotal === 0) {
    resetProgressBar();
    return;
  }
  const safeProcessed = Math.min(Math.max(0, Number(processed) || 0), safeTotal);
  const pct = Math.min(100, Math.round((safeProcessed / safeTotal) * 100));
  statusBarEl.classList.remove('hidden');
  statusBarEl.setAttribute('aria-hidden', 'false');
  statusBarEl.setAttribute('aria-valuemin', '0');
  statusBarEl.setAttribute('aria-valuemax', '100');
  statusBarEl.setAttribute('aria-valuenow', String(pct));
  statusFillEl.style.width = `${pct}%`;
  statusFillEl.textContent = `${pct}%`;
}

function startElapsedTimer(){
  stopElapsedTimer();
  if (!sumTimeEl) return;
  sumTimeEl.textContent = '0s';
  checkTimerId = setInterval(() => {
    if (checkStartTs) {
      sumTimeEl.textContent = formatDuration(Date.now() - checkStartTs);
    }
  }, 1000);
}

function stopElapsedTimer(){
  if (checkTimerId) {
    clearInterval(checkTimerId);
    checkTimerId = null;
  }
}

function appendResultRow(r){
  const tr = document.createElement('tr');
  const url = r && r.url ? r.url : '';
  const href = url ? encodeURI(url) : '';
  tr.innerHTML = `<td><a href="${href}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a></td><td>${r.status||''}</td><td>${r.ok}</td><td>${r.responseTimeMs ?? ''}</td><td>${r.hasH1}</td><td>${r.h1Count ?? ''}</td><td>${r.h1Length ?? ''}</td><td>${r.multipleH1 ?? ''}</td><td>${escapeHtml(r.title||'')}</td><td>${escapeHtml(r.metaDescription||'')}</td><td>${escapeHtml(r.canonical||'')}</td><td>${escapeHtml(r.h1||'')}</td><td>${escapeHtml(r.error||'')}</td>`;
  tbody.appendChild(tr);
}

function resetResults(){
  tbody.innerHTML = '';
  resultsCollapsed = true;
  resultsToggle.disabled = true;
  setResultsPanelVisible(false);
  resetProgressBar();
  stopElapsedTimer();
  exportControls.classList.add('hidden');
  lastResults = [];
  summaryEl.classList.add('hidden');
  sumTotalEl.textContent = '0';
  sumH1El.textContent = '0';
  sumMissingH1El.textContent = '0';
  sumMultipleH1El.textContent = '0';
  sumTimeEl.textContent = '0s';
  sum200El.textContent = '0';
  sum4xxEl.textContent = '0';
  sum5xxEl.textContent = '0';
  if (statusPieEl) {
    statusPieEl.style.setProperty('--p200', '0deg');
    statusPieEl.style.setProperty('--p4xx', '0deg');
    statusPieEl.style.setProperty('--p5xx', '0deg');
  }
}

function updateUrlCount(){
  const count = loadedUrls.length;
  urlCountEl.textContent = String(count);
  return count;
}

function isSuccess(r){
  return Boolean(r && r.ok && r.hasH1 && !r.error);
}

function updateSummary(){
  const rows = lastResults.filter(Boolean);
  const total = rows.length;
  let withH1 = 0;
  let missingH1 = 0;
  let multipleH1 = 0;
  let count200 = 0;
  let count4xx = 0;
  let count5xx = 0;
  for (const r of rows) {
    if (r && r.hasH1) withH1 += 1;
    if (r && (r.missingH1 || r.hasH1 === false)) missingH1 += 1;
    if (r && r.multipleH1) multipleH1 += 1;
    if (r && typeof r.status === 'number') {
      if (r.status >= 200 && r.status <= 299) count200 += 1;
      if (r.status >= 400 && r.status <= 499) count4xx += 1;
      if (r.status >= 500 && r.status <= 599) count5xx += 1;
    }
  }
  sumTotalEl.textContent = String(total);
  sumH1El.textContent = String(withH1);
  sumMissingH1El.textContent = String(missingH1);
  sumMultipleH1El.textContent = String(multipleH1);
  sum200El.textContent = String(count200);
  sum4xxEl.textContent = String(count4xx);
  sum5xxEl.textContent = String(count5xx);
  if (statusPieEl) {
    const denom = total || 1;
    const p200 = (count200 / denom) * 360;
    const p4xx = (count4xx / denom) * 360;
    const p5xx = (count5xx / denom) * 360;
    statusPieEl.style.setProperty('--p200', `${p200}deg`);
    statusPieEl.style.setProperty('--p4xx', `${p4xx}deg`);
    statusPieEl.style.setProperty('--p5xx', `${p5xx}deg`);
  }
  if (total > 0) {
    summaryEl.classList.remove('hidden');
    resultsToggle.disabled = false;
  } else {
    summaryEl.classList.add('hidden');
    resultsToggle.disabled = true;
    setResultsPanelVisible(false);
  }
}

function setResultsPanelVisible(visible){
  resultsPanel.classList.toggle('hidden', !visible);
  resultsTable.classList.toggle('hidden', !visible);
  resultsToggle.setAttribute('aria-expanded', visible ? 'true' : 'false');
  resultsToggle.textContent = visible ? 'Hide results table' : 'Show results table';
}

function csvEscape(value){
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(rows){
  const headers = ['url','status','ok','responseTimeMs','hasH1','h1Count','h1Length','multipleH1','missingH1','title','metaDescription','canonical','h1','error'];
  const lines = [headers.join(',')];
  for(const r of rows){
    const row = headers.map((key) => csvEscape(r[key]));
    lines.push(row.join(','));
  }
  return lines.join('\r\n');
}

function downloadCsv(text, filename){
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

exportBtn.addEventListener('click', () => {
  const rowsAll = lastResults.filter(Boolean);
  if (!rowsAll.length) return alert('No results to export');
  const filter = exportFilterEl.value;
  let rows = rowsAll;
  if (filter === 'success') rows = rowsAll.filter(isSuccess);
  if (filter === 'fail') rows = rowsAll.filter((r) => !isSuccess(r));
  const csv = buildCsv(rows);
  const name = `h1-results-${filter}.csv`;
  downloadCsv(csv, name);
});

updateUrlCount();
syncInputMode();
if (sitemapUrlEl) {
  sitemapUrlEl.addEventListener('paste', () => {
    setTimeout(() => {
      autoDetectMode(sitemapUrlEl.value);
    }, 0);
  });
}

function listenToCheckStream(jobId, totalHint){
  if (checkSource) {
    checkSource.close();
  }
  let finished = false;
  let processed = 0;
  let total = typeof totalHint === 'number' ? totalHint : 0;
  const es = new EventSource(`/api/check-events?jobId=${encodeURIComponent(jobId)}`);
  checkSource = es;

  const finish = (message) => {
    if (finished) return;
    finished = true;
    stopElapsedTimer();
    if (message) setStatus(message);
    if (checkSource) {
      checkSource.close();
      checkSource = null;
    }
    checkJobId = null;
    checkStartTs = null;
  };

  es.addEventListener('start', (evt) => {
    const payload = JSON.parse(evt.data || '{}');
    if (typeof payload.total === 'number') total = payload.total;
    setStatus(`Checking ${total} URLs...`);
    updateProgressBar(processed, total);
  });

  es.addEventListener('progress', (evt) => {
    const payload = JSON.parse(evt.data || '{}');
    processed = typeof payload.processed === 'number' ? payload.processed : processed + 1;
    if (typeof payload.total === 'number') total = payload.total;
    setStatus(`Checking ${total} URLs...`);
    updateProgressBar(processed, total);
    if (payload.result) {
      lastResults[payload.index] = payload.result;
      appendResultRow(payload.result);
      updateSummary();
    }
  });

  es.addEventListener('done', (evt) => {
    const payload = JSON.parse(evt.data || '{}');
    const doneCount = typeof payload.processed === 'number' ? payload.processed : processed;
    if (checkStartTs && sumTimeEl) {
      const elapsed = Date.now() - checkStartTs;
      const label = formatDuration(elapsed);
      sumTimeEl.textContent = label;
      updateProgressBar(doneCount, payload.total ?? total);
      finish(`Done. Checked ${doneCount} URLs. Time: ${label}`);
    } else {
      updateProgressBar(doneCount, payload.total ?? total);
      finish(`Done. Checked ${doneCount} URLs.`);
    }
    updateSummary();
    if (lastResults.filter(Boolean).length) {
      exportControls.classList.remove('hidden');
    }
  });

  es.addEventListener('failed', (evt) => {
    const payload = JSON.parse(evt.data || '{}');
    if (checkStartTs && sumTimeEl) {
      const label = formatDuration(Date.now() - checkStartTs);
      sumTimeEl.textContent = label;
    }
    updateProgressBar(payload.processed ?? processed, payload.total ?? total);
    finish(`Error: ${payload.error || 'Check failed'}`);
  });

  es.addEventListener('ping', () => {
    // keep-alive
  });

  es.onerror = () => {
    if (!finished) finish('Error: check stream disconnected');
  };
}

function cancelCheckJob(){
  if (!checkJobId) return;
  postJson('/api/check-cancel', { jobId: checkJobId }).catch(() => {});
  checkJobId = null;
}

async function startCheck(lines){
  if (!lines.length) {
    setStatus('No URLs found in sitemap.');
    return;
  }
  resetResults();
  checkStartTs = Date.now();
  sumTimeEl.textContent = '0s';
  setStatus(`Starting check for ${lines.length} URLs...`);
  updateProgressBar(0, lines.length);
  startElapsedTimer();
  if (checkSource) {
    checkSource.close();
    checkSource = null;
  }
  cancelCheckJob();
  try{
    const json = await postJson('/api/check-job', { urls: lines, concurrency: defaultConcurrency });
    checkJobId = json.jobId;
    listenToCheckStream(json.jobId, json.total);
  }catch(err){
    setStatus('Error: '+err.message);
    resetProgressBar();
    stopElapsedTimer();
  }
}

function formatDuration(ms){
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function showFavicon(url){
  if (!faviconEl || !siteBadgeEl) return;
  try {
    const parsed = new URL(url);
    const origin = parsed.origin;
    const faviconUrl = `${origin}/favicon.ico`;
    faviconEl.src = faviconUrl;
    faviconEl.onerror = () => {
      faviconEl.onerror = null;
      faviconEl.src = `${origin}/favicon.png`;
    };
    if (siteHostEl) siteHostEl.textContent = parsed.hostname;
    siteBadgeEl.classList.remove('hidden');
  } catch (err) {
    hideFavicon();
  }
}

function hideFavicon(){
  if (siteBadgeEl) siteBadgeEl.classList.add('hidden');
  if (faviconEl) faviconEl.removeAttribute('src');
  if (siteHostEl) siteHostEl.textContent = '';
}

function getInputMode(){
  return modeSitemapEl && modeSitemapEl.checked ? 'sitemap' : 'site';
}

function syncInputMode(){
  const mode = getInputMode();
  if (sitemapLabelEl) sitemapLabelEl.textContent = mode === 'site' ? 'Site URL' : 'Sitemap URL';
  if (sitemapUrlEl) {
    sitemapUrlEl.placeholder = mode === 'site' ? 'https://example.com' : 'https://example.com/sitemap.xml';
  }
}

if (modeSiteEl) modeSiteEl.addEventListener('change', syncInputMode);
if (modeSitemapEl) modeSitemapEl.addEventListener('change', syncInputMode);

function normalizeUrl(input){
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

function autoDetectMode(value){
  const raw = (value || '').trim();
  if (!raw) return;
  const lower = raw.toLowerCase();
  const isSitemap = /sitemap\.xml$/.test(lower) || (lower.includes('sitemap') && lower.endsWith('.xml'));
  if (modeSitemapEl && modeSiteEl) {
    modeSitemapEl.checked = isSitemap;
    modeSiteEl.checked = !isSitemap;
    syncInputMode();
  }
}

function buildSitemapUrl(input){
  let url = normalizeUrl(input);
  if (!/\/sitemap\.xml$/i.test(url)) {
    url = url.replace(/\/+$/, '');
    url = `${url}/sitemap.xml`;
  }
  return url;
}
