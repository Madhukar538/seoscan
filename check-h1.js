#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { AbortController } = require('abort-controller');
const { parse } = require('csv-parse/sync');

function usage() {
  console.log(`Usage: node check-h1.js [--file urls.txt] [--csv-in urls.csv] [--csv-out report.csv] [--html-out report.html] [--export all|failed|both] [--url https://example.com] [--concurrency N] [--json]`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { urls: [], file: null, csvIn: null, csvOut: null, htmlOut: null, export: null, concurrency: 5, json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-f' || a === '--file') {
      opts.file = args[++i];
    } else if (a === '--url') {
      opts.urls.push(args[++i]);
    } else if (a === '--csv-in') {
      opts.csvIn = args[++i];
    } else if (a === '--csv-out') {
      opts.csvOut = args[++i];
    } else if (a === '--html-out') {
      opts.htmlOut = args[++i];
    } else if (a === '--export') {
      opts.export = args[++i];
    } else if (a === '-c' || a === '--concurrency') {
      opts.concurrency = parseInt(args[++i], 10) || 5;
    } else if (a === '--json') {
      opts.json = true;
    } else if (a === '-h' || a === '--help') {
      usage();
      process.exit(0);
    } else {
      // treat as positional URL
      opts.urls.push(a);
    }
  }
  return opts;
}

function readUrlsFromFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
  } catch (err) {
    console.error(`Failed to read file ${filePath}: ${err.message}`);
    process.exit(2);
  }
}

function readUrlsFromCsv(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    // Try parse with columns (header) first
    try {
      const records = parse(raw, { columns: true, skip_empty_lines: true });
      if (records && records.length > 0 && typeof records[0] === 'object') {
        // find a column named url or URL
        const keys = Object.keys(records[0]);
        const urlKey = keys.find(k => k.toLowerCase() === 'url') || keys[0];
        return records.map(r => (r[urlKey] || '').toString().trim()).filter(Boolean);
      }
    } catch (e) {
      // fallthrough to no-header parsing
    }
    // no header / fallback
    const rows = parse(raw, { columns: false, skip_empty_lines: true });
    return rows.map(r => (Array.isArray(r) ? r[0] : r).toString().trim()).filter(Boolean);
  } catch (err) {
    console.error(`Failed to read CSV ${filePath}: ${err.message}`);
    process.exit(2);
  }
}

async function fetchWithTimeout(url, ms = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': 'h1-checker/1.0' } });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

async function checkUrl(url) {
  const out = { url, status: null, ok: false, hasH1: false, h1: null, error: null };
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
    const h1 = $('h1').first();
    if (h1 && h1.length > 0) {
      out.hasH1 = true;
      out.h1 = h1.text().trim();
    }
  } catch (err) {
    out.error = err.name === 'AbortError' ? 'timeout' : err.message;
  }
  return out;
}

async function run(urls, concurrency) {
  const results = new Array(urls.length);
  let i = 0;
  async function worker() {
    while (true) {
      let idx = i++;
      if (idx >= urls.length) break;
      const url = urls[idx];
      let normalized = url;
      if (!/^https?:\/\//i.test(normalized)) normalized = 'http://' + normalized;
      try {
        results[idx] = await checkUrl(normalized);
      } catch (err) {
        results[idx] = { url: normalized, status: null, ok: false, hasH1: false, h1: null, error: err.message };
      }
    }
  }
  const workers = [];
  const w = Math.max(1, Math.min(concurrency, urls.length));
  for (let k = 0; k < w; k++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

(async function main() {
  const opts = parseArgs();
  if (opts.file) {
    const fromFile = readUrlsFromFile(opts.file);
    opts.urls.push(...fromFile);
  }
  if (opts.csvIn) {
    const fromCsv = readUrlsFromCsv(opts.csvIn);
    opts.urls.push(...fromCsv);
  }
  if (!opts.urls || opts.urls.length === 0) {
    usage();
    process.exit(1);
  }
  const results = await run(opts.urls, opts.concurrency);

  // write CSV report if asked
  if (opts.csvOut) {
    try {
      writeCsvReport(results, opts.csvOut);
      console.log(`CSV report written: ${opts.csvOut}`);
    } catch (err) {
      console.error(`Failed to write CSV report: ${err.message}`);
    }
  }

  // handle exports (filtered CSVs) if requested
  let exportedAllPath = null;
  let exportedFailedPath = null;
  if (opts.export) {
    const outDir = opts.htmlOut ? path.dirname(opts.htmlOut) : process.cwd();
    if (opts.export === 'all' || opts.export === 'both') {
      exportedAllPath = path.join(outDir, 'report_all.csv');
      writeCsvReport(results, exportedAllPath);
    }
    if (opts.export === 'failed' || opts.export === 'both') {
      exportedFailedPath = path.join(outDir, 'report_failed.csv');
      writeCsvReport(results, exportedFailedPath, r => !!(r.error || !r.hasH1));
    }
  }

  // write HTML report if requested
  if (opts.htmlOut) {
    try {
      writeHtmlReport(results, opts.htmlOut, { allCsv: exportedAllPath, failedCsv: exportedFailedPath });
      console.log(`HTML report written: ${opts.htmlOut}`);
    } catch (err) {
      console.error(`Failed to write HTML report: ${err.message}`);
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
    process.exit(0);
  }

  // pretty table
  for (const r of results) {
    const status = r.error ? `ERR (${r.error})` : r.ok ? `OK (${r.status})` : `FAIL (${r.status})`;
    const h1Text = r.hasH1 ? r.h1 : '-';
    console.log(`${r.url}  |  ${status}  |  hasH1: ${r.hasH1}  |  ${h1Text}`);
  }
})();

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('\n') || s.includes('"')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function writeCsvReport(results, outPath) {
  return writeCsvReportFiltered(results, outPath, null);
}

function writeCsvReportFiltered(results, outPath, filterFn) {
  const header = ['url', 'status', 'ok', 'hasH1', 'h1', 'error'];
  const lines = [header.join(',')];
  for (const r of results) {
    if (filterFn && !filterFn(r)) continue;
    const row = [r.url || '', r.status || '', r.ok || false, r.hasH1 || false, r.h1 || '', r.error || ''];
    lines.push(row.map(csvEscape).join(','));
  }
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  return outPath;
}

function writeCsvReport(results, outPath, filterFn) {
  return writeCsvReportFiltered(results, outPath, filterFn || null);
}

function writeHtmlReport(results, outPath, extras) {
  const rows = results.map(r => {
    return `\n      <tr>\n        <td><a href="${r.url}">${r.url}</a></td>\n        <td>${r.status || ''}</td>\n        <td>${r.ok}</td>\n        <td>${r.hasH1}</td>\n        <td>${escapeHtml(r.h1 || '')}</td>\n        <td>${escapeHtml(r.error || '')}</td>\n      </tr>`;
  }).join('\n');

  const links = [];
  if (extras && extras.allCsv) links.push(`<a href="${path.basename(extras.allCsv)}">Download All CSV</a>`);
  if (extras && extras.failedCsv) links.push(`<a href="${path.basename(extras.failedCsv)}">Download Failed CSV</a>`);

  const html = `<!doctype html>\n<html>\n<head>\n  <meta charset="utf-8" />\n  <title>H1 Report</title>\n  <style>\n    table{border-collapse:collapse;width:100%;}\n    th,td{border:1px solid #ccc;padding:6px;text-align:left}\n    th{background:#f7f7f7}\n  </style>\n</head>\n<body>\n  <h1>H1 Checker Report</h1>\n  <p>${links.join(' | ')}</p>\n  <table>\n    <thead><tr><th>URL</th><th>Status</th><th>OK</th><th>hasH1</th><th>h1</th><th>error</th></tr></thead>\n    <tbody>\n      ${rows}\n    </tbody>\n  </table>\n</body>\n</html>`;

  fs.writeFileSync(outPath, html, 'utf8');
}

function escapeHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
