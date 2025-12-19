require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const cheerio = require('cheerio');
const { AbortController } = require('abort-controller');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { randomUUID } = require('crypto');

const defaultConcurrency = Math.max(1, Number(process.env.DEFAULT_CONCURRENCY) || 5);
const requestTimeoutMs = Math.max(1000, Number(process.env.REQUEST_TIMEOUT_MS) || 15000);
const jobTtlMs = Math.max(1, Number(process.env.JOB_TTL_MINUTES) || 10) * 60 * 1000;
const uploadLimitMb = Math.max(1, Number(process.env.UPLOAD_LIMIT_MB) || 5);
const userAgent = process.env.USER_AGENT || 'h1-checker/1.0';
const sitemapMaxDepth = Math.max(1, Number(process.env.SITEMAP_MAX_DEPTH) || 5);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const AbortControllerImpl = global.AbortController || AbortController;

// multer setup (memory storage) for CSV uploads
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: uploadLimitMb * 1024 * 1024 } });

const jobs = new Map();

function initSse(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();
  res.write(`:${' '.repeat(2048)}\n\n`);
  if (res.flush) res.flush();
}

function sendSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  if (res.flush) res.flush();
}

function createJob(urls) {
  const job = {
    id: randomUUID(),
    total: urls.length,
    processed: 0,
    results: new Array(urls.length),
    events: [],
    clients: new Set(),
    done: false,
    cancelled: false,
    cleanupTimer: null
  };
  jobs.set(job.id, job);
  return job;
}

function cleanupJob(job) {
  if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
  job.cleanupTimer = setTimeout(() => {
    jobs.delete(job.id);
  }, jobTtlMs);
}

function pushJobEvent(job, event, payload) {
  job.events.push({ event, payload });
  for (const res of job.clients) {
    sendSse(res, event, payload);
    if (event === 'done' || event === 'failed') {
      res.end();
    }
  }
  if (event === 'done' || event === 'failed') {
    job.clients.clear();
  }
}

async function fetchWithTimeout(url, ms = requestTimeoutMs) {
  const controller = new AbortControllerImpl();
  let fetchPromise;
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      const err = new Error('timeout');
      err.name = 'AbortError';
      reject(err);
    }, ms);
  });
  try {
    fetchPromise = fetch(url, { signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': userAgent } });
    const res = await Promise.race([fetchPromise, timeoutPromise]);
    clearTimeout(timeoutId);
    return res;
  } catch (err) {
    if (typeof fetchPromise?.catch === 'function') {
      fetchPromise.catch(() => {});
    }
    clearTimeout(timeoutId);
    throw err;
  }
}

async function checkUrl(url) {
  const out = {
    url,
    status: null,
    ok: false,
    responseTimeMs: null,
    hasH1: false,
    h1Count: 0,
    h1Length: 0,
    multipleH1: false,
    missingH1: true,
    h1: null,
    title: null,
    metaDescription: null,
    canonical: null,
    error: null
  };
  const start = Date.now();
  try {
    const res = await fetchWithTimeout(url);
    out.status = res.status;
    out.ok = res.ok;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
      out.error = `non-html content-type: ${contentType}`;
      return out;
    }
    const text = await res.text();
    const $ = cheerio.load(text);
    const titleText = $('title').first().text().trim();
    out.title = titleText || null;

    const metaDesc = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content');
    out.metaDescription = metaDesc ? metaDesc.trim() : null;

    const canonicalHref = $('link[rel="canonical"]').attr('href');
    out.canonical = canonicalHref ? canonicalHref.trim() : null;

    const h1s = $('h1');
    out.h1Count = h1s.length;
    out.multipleH1 = out.h1Count > 1;
    out.missingH1 = out.h1Count === 0;
    if (out.h1Count > 0) {
      const h1Text = h1s.first().text().trim();
      out.hasH1 = true;
      out.h1 = h1Text;
      out.h1Length = h1Text.length;
    }
  } catch (err) {
    out.error = err.name === 'AbortError' ? 'timeout' : err.message;
  } finally {
    out.responseTimeMs = Date.now() - start;
  }
  return out;
}

async function run(urls, concurrency = defaultConcurrency) {
  const results = new Array(urls.length);
  let i = 0;
  async function worker() {
    while (true) {
      let idx = i++;
      if (idx >= urls.length) break;
      let url = urls[idx];
      if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
      try {
        results[idx] = await checkUrl(url);
      } catch (err) {
        results[idx] = {
          url,
          status: null,
          ok: false,
          responseTimeMs: null,
          hasH1: false,
          h1Count: 0,
          h1Length: 0,
          multipleH1: false,
          missingH1: true,
          h1: null,
          title: null,
          metaDescription: null,
          canonical: null,
          error: err.message
        };
      }
    }
  }
  const workers = [];
  const w = Math.max(1, Math.min(concurrency, urls.length));
  for (let k = 0; k < w; k++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

async function runStreaming(urls, concurrency = defaultConcurrency, onResult, shouldStop) {
  let i = 0;
  async function worker() {
    while (true) {
      if (shouldStop && shouldStop()) break;
      let idx = i++;
      if (idx >= urls.length) break;
      let url = urls[idx];
      if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
      let result;
      try {
        result = await checkUrl(url);
      } catch (err) {
        result = {
          url,
          status: null,
          ok: false,
          responseTimeMs: null,
          hasH1: false,
          h1Count: 0,
          h1Length: 0,
          multipleH1: false,
          missingH1: true,
          h1: null,
          title: null,
          metaDescription: null,
          canonical: null,
          error: err.message
        };
      }
      if (shouldStop && shouldStop()) break;
      await onResult(idx, result);
    }
  }
  const workers = [];
  const w = Math.max(1, Math.min(concurrency, urls.length));
  for (let k = 0; k < w; k++) workers.push(worker());
  await Promise.all(workers);
}

function parseSitemapXml(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const urlLocs = [];
  $('urlset > url > loc').each((_, el) => {
    const loc = $(el).text().trim();
    if (loc) urlLocs.push(loc);
  });
  const sitemapLocs = [];
  $('sitemapindex > sitemap > loc').each((_, el) => {
    const loc = $(el).text().trim();
    if (loc) sitemapLocs.push(loc);
  });
  return { urlLocs, sitemapLocs };
}

app.post('/api/check', async (req, res) => {
  try {
    const { urls, concurrency } = req.body;
    if (!Array.isArray(urls) || urls.length === 0) return res.status(400).json({ error: 'urls must be a non-empty array' });
    const results = await run(urls, Number(concurrency) || defaultConcurrency);
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/check-job', async (req, res) => {
  const { urls, concurrency } = req.body || {};
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls must be a non-empty array' });
  }

  const job = createJob(urls);
  pushJobEvent(job, 'start', { total: job.total });
  res.json({ jobId: job.id, total: job.total });

  runStreaming(urls, Number(concurrency) || defaultConcurrency, (index, result) => {
    if (job.cancelled) return;
    job.results[index] = result;
    job.processed += 1;
    pushJobEvent(job, 'progress', { index, result, processed: job.processed, total: job.total });
  }, () => job.cancelled).then(() => {
    if (job.done) return;
    if (job.cancelled) {
      job.done = true;
      pushJobEvent(job, 'failed', { error: 'cancelled' });
    } else {
      job.done = true;
      pushJobEvent(job, 'done', { processed: job.processed, total: job.total });
    }
    cleanupJob(job);
  }).catch((err) => {
    if (job.done) return;
    job.done = true;
    pushJobEvent(job, 'failed', { error: err.message });
    cleanupJob(job);
  });
});

app.get('/api/check-events', (req, res) => {
  const jobId = (req.query.jobId || '').toString().trim();
  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });

  initSse(res);

  const heartbeat = setInterval(() => {
    sendSse(res, 'ping', {});
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    job.clients.delete(res);
  });

  for (const evt of job.events) {
    sendSse(res, evt.event, evt.payload);
  }

  if (job.done) {
    clearInterval(heartbeat);
    return res.end();
  }

  job.clients.add(res);
});

app.post('/api/check-cancel', (req, res) => {
  const { jobId } = req.body || {};
  const job = jobs.get(jobId);
  if (!job) return res.json({ ok: false });
  job.cancelled = true;
  if (!job.done) {
    job.done = true;
    pushJobEvent(job, 'failed', { error: 'cancelled' });
    cleanupJob(job);
  }
  return res.json({ ok: true });
});

app.post('/api/check-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();

  let closed = false;
  const heartbeat = setInterval(() => {
    if (closed) return;
    res.write('event: ping\n');
    res.write('data: {}\n\n');
    if (res.flush) res.flush();
  }, 15000);

  req.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
  });

  const send = (event, payload) => {
    if (closed) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    if (res.flush) res.flush();
  };

  const { urls, concurrency } = req.body || {};
  if (!Array.isArray(urls) || urls.length === 0) {
    send('failed', { error: 'urls must be a non-empty array' });
    clearInterval(heartbeat);
    return res.end();
  }

  const total = urls.length;
  let processed = 0;
  send('start', { total });

  try {
    await runStreaming(urls, Number(concurrency) || 5, (index, result) => {
      processed += 1;
      send('progress', { index, result, processed, total });
    });
    send('done', { processed, total });
    clearInterval(heartbeat);
    return res.end();
  } catch (err) {
    send('failed', { error: err.message });
    clearInterval(heartbeat);
    return res.end();
  }
});

app.get('/api/sitemap-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();

  const send = (event, payload) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const rawUrl = (req.query.url || '').toString().trim();
  if (!rawUrl) {
    send('failed', { error: 'sitemap url required' });
    return res.end();
  }

  let sitemapUrl;
  try {
    const parsed = new URL(rawUrl);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('invalid protocol');
    sitemapUrl = parsed.toString();
  } catch (err) {
    send('failed', { error: 'invalid sitemap url' });
    return res.end();
  }

  let closed = false;
  req.on('close', () => { closed = true; });

  const visitedSitemaps = new Set();
  const seenUrls = new Set();
  const queue = [{ url: sitemapUrl, depth: 0 }];
  const maxDepth = sitemapMaxDepth;
  let total = 0;

  try {
    while (queue.length && !closed) {
      const { url, depth } = queue.shift();
      if (visitedSitemaps.has(url)) continue;
      visitedSitemaps.add(url);

      let xml;
      try {
        const resXml = await fetchWithTimeout(url);
        if (!resXml.ok) {
          send('failed', { error: `sitemap fetch failed: ${resXml.status}` });
          return res.end();
        }
        xml = await resXml.text();
      } catch (err) {
        send('failed', { error: err.message });
        return res.end();
      }

      const { urlLocs, sitemapLocs } = parseSitemapXml(xml);
      if (depth < maxDepth) {
        for (const loc of sitemapLocs) {
          if (!visitedSitemaps.has(loc)) queue.push({ url: loc, depth: depth + 1 });
        }
      }

      const newUrls = [];
      for (const loc of urlLocs) {
        if (!loc || seenUrls.has(loc)) continue;
        seenUrls.add(loc);
        newUrls.push(loc);
      }

      const chunkSize = 200;
      for (let i = 0; i < newUrls.length; i += chunkSize) {
        const batch = newUrls.slice(i, i + chunkSize);
        total += batch.length;
        send('batch', { urls: batch, total });
      }
    }

    if (!closed) {
      send('done', { total });
      return res.end();
    }
  } catch (err) {
    if (!closed) {
      send('failed', { error: err.message });
      return res.end();
    }
  }
});

// accept CSV upload and return parsed URLs
app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file required' });
    const raw = req.file.buffer.toString('utf8');
    // try header-aware parse first
    let urls = [];
    try {
      const records = parse(raw, { columns: true, skip_empty_lines: true });
      if (records && records.length > 0 && typeof records[0] === 'object') {
        const keys = Object.keys(records[0]);
        const urlKey = keys.find(k => k.toLowerCase() === 'url') || keys[0];
        urls = records.map(r => (r[urlKey] || '').toString().trim()).filter(Boolean);
      }
    } catch (e) {
      // fallback to no-header
      const rows = parse(raw, { columns: false, skip_empty_lines: true });
      urls = rows.map(r => (Array.isArray(r) ? r[0] : r).toString().trim()).filter(Boolean);
    }
    return res.json({ urls });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT) || 3002;
app.listen(port,'0.0.0.0', () => {
  console.log(`Server listening on http://localhost:${port}`);
});
