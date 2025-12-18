const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

function splitCsvRow(s) {
  return s.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(cell => {
    cell = cell.trim();
    if (cell.startsWith('"') && cell.endsWith('"')) {
      return cell.slice(1, -1).replace(/""/g, '"');
    }
    return cell;
  });
}

const cmd = 'node check-h1.js --csv-in test/urls.csv --csv-out test/report.csv --json --concurrency 2';
console.log('Running:', cmd);
exec(cmd, { cwd: path.resolve(__dirname, '..'), timeout: 120000 }, (err, stdout, stderr) => {
  if (err) {
    console.error('Runner error:', err && err.message);
    console.error(stderr);
    process.exit(2);
  }
  const reportPath = path.join(__dirname, 'report.csv');
  if (!fs.existsSync(reportPath)) {
    console.error('report.csv not generated');
    process.exit(2);
  }
  const raw = fs.readFileSync(reportPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    console.error('report.csv has insufficient rows');
    process.exit(2);
  }
  const header = lines[0].split(',');
  if (header[0] !== 'url') {
    console.error('unexpected header:', header);
    process.exit(2);
  }
  const exampleLine = lines.find(l => l.includes('example.com'));
  if (!exampleLine) {
    console.error('example.com row missing in report');
    process.exit(2);
  }
  const cols = splitCsvRow(exampleLine);
  // header: url,status,ok,hasH1,h1,error -> hasH1 is index 3
  const hasH1 = cols[3];
  if (hasH1 !== 'true') {
    console.error('expected example.com to have hasH1=true but was', hasH1);
    process.exit(2);
  }
  console.log('Test passed — report.csv generated and example.com has H1');
  process.exit(0);
});
