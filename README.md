# H1 Checker

Small Node.js CLI to check whether a list of URLs contain an `<h1>` tag.

## Installation

```bash
cd /path/to/project
npm install
```

## Usage

Check URLs from a file:

```bash
node check-h1.js --file urls.txt
```

Check URLs from a CSV (first column or column named `url`):

```bash
node check-h1.js --csv-in urls.csv --csv-out report.csv
```

The `report.csv` will contain: `url,status,ok,hasH1,h1,error`.

Generate an HTML report and optional CSV exports:

```bash
# generate HTML and also write filtered CSV exports (failed and all)
node check-h1.js --csv-in urls.csv --html-out report.html --export both

# generate HTML only
node check-h1.js --csv-in urls.csv --html-out report.html
```

When using `--export failed` a `report_failed.csv` will be created next to the HTML file. When using `--export all` a `report_all.csv` will be created. Use `--export both` to create both files and include links to them in the HTML report.


Check a single URL:

```bash
node check-h1.js --url https://example.com
```

Check multiple URLs (positional):

```bash
node check-h1.js https://example.com https://nodejs.org
```

Output JSON:

```bash
node check-h1.js --file urls.txt --json
```

Adjust concurrency with `--concurrency` (default 5):

```bash
node check-h1.js --file urls.txt --concurrency 10
```

## Notes
- Requires Node.js 18+ for global `fetch` (or use a fetch polyfill).
- Installs `cheerio` to parse HTML.

