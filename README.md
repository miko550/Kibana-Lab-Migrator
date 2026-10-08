# Kibana Lab Migrator

A read-only export tool that runs inside a Kibana tab. Use it on any lab where
you only have Kibana (Dev Tools) access, to pull indices out, save their
mappings, and generate a matching loader script for the destination cluster.

It talks to the cluster through the Kibana console proxy — the same path Dev
Tools uses — so it needs no API key, no CLI, and no privileges beyond your
Kibana login. It only reads: it never writes to or deletes from the source.

## Files

- `kibana-lab-migrator.js` — the tool source. Paste into the browser DevTools
  Console. This is the reliable method and works regardless of Kibana's CSP.
- `kibana-lab-migrator.bookmarklet.txt` — the same tool as a bookmarklet URL.
- `README.md` — this file.

## Install (bookmarklet)

1. Create any new bookmark in Chrome (bookmark this page, then edit it).
2. Replace the URL with the entire contents of
   `kibana-lab-migrator.bookmarklet.txt`.
3. Name it "Lab Migrator".
4. Open a Kibana tab (any space), then click the bookmark. A panel appears
   top-right.

If clicking the bookmark does nothing, the page's CSP blocked it. Use the
console method instead.

## Install (console — always works)

1. In the Kibana tab, press F12 → Console.
2. Paste the entire contents of `kibana-lab-migrator.js` and press Enter.
3. The panel appears. (Chrome may ask you to type `allow pasting` the first
   time.)

## Use

The panel header shows the cluster name, ES version, and your user — check
this is the right lab before doing anything.

1. **Select indices** from the list (system indices starting with `.` are
   hidden).
2. **Analyze selected** — pulls doc counts and detects date fields. For each
   index it suggests the populated date field and shows a dropdown so you can
   confirm or change it (or pick "no time field" to export the whole index in
   one file). Empty date fields like `@timestamp` are shown but not chosen.
3. **Export** — streams each index to gzipped NDJSON in your Downloads folder.
   Indices with a time field are split into one file per UTC day; empty days
   are skipped. Each file's doc count is checked against `_count`. Allow
   multiple downloads if Chrome prompts.
4. **Save mappings** — downloads the real mappings for the selected indices as
   `mappings_<cluster>.json`.
5. **Generate loader** — downloads `load_<cluster>.sh`, a self-contained script
   with those indices' mappings, expected counts, and per-index time fields
   baked in.

## Loading into the destination cluster

On a machine with `curl`, `jq`, `gzip`, and `elasticdump` (`npm i -g
elasticdump`), put the generated `.sh` next to the exported `.ndjson.gz` files:

```bash
chmod +x load_<cluster>.sh
./load_<cluster>.sh -u https://target-es:9200 -k <ENCODED_API_KEY> -d . -i \
  -K https://target-kibana:5601
```

Key flags: `-k`/`-U`+`-P` for auth, `-d` data dir, `-K` Kibana URL to create
data views, `-i` skip TLS verify (self-signed), `-f` recreate existing
indices, `-r 0` for a single-node target. Run `./load_<cluster>.sh -h` for all.

The loader creates each index with its source mapping, bulk-loads the files,
restores replica/refresh settings, verifies every count, and creates data
views with the right time field per index.

## Data streams

Both tools detect data streams automatically and handle them end to end:

- **Export** captures the stream's docs *and* the definition needed to rebuild
  it: the index template, its component templates, and the ILM policy (if any).
  These land in a `templates/` folder (shell tool) or as `templates__*.json`
  files (bookmarklet). The `manifest.txt` marks each target `index` or
  `data_stream`.
- **Load** (`load_dataset.sh`) reads the manifest. For a data stream it creates
  the component templates, index template, and ILM policy, creates the stream,
  then bulk-indexes with the `create` op that data streams require. For a plain
  index it does the original create-mapping + elasticdump path (or a curl bulk
  fallback if elasticdump isn't installed).

Nothing extra to do — if a lab has data streams, the same export → load flow
just works. Verified end to end against Elasticsearch 9.5.4 (plain index and
data stream in one bundle).

## Files

- `kibana-lab-migrator.js` / `.bookmarklet.txt` — in-Kibana export tool.
- `export_from_es.sh` — export straight from Elasticsearch (no Kibana needed).
- `load_dataset.sh` — restore a bundle (indices + data streams) onto a target.

## Load command

```bash
chmod +x load_dataset.sh
./load_dataset.sh -u https://target:9200 -k <API_KEY> -d ./export_dir -i \
  -K https://target-kibana:5601
```

## Kibana version note

Works on Kibana 8.x and 9.x. On 9.x the console proxy requires the
`x-elastic-internal-origin: Kibana` header (the tool sends it) and rejects an
empty request path, so the tool queries `/` for cluster info. No server config
change is needed — Dev Tools Console being enabled is enough.

## Notes and limits

- Runs in the browser, so it's bound by tab memory. For very large indices,
  daily splitting keeps each file manageable; extremely high-volume single days
  may still be heavy. Keep the tab open and the machine awake during export.
- `_id` values are not preserved (only `_source` is exported), so the target
  assigns fresh ids. Fine unless something references the original ids.
- Auto-detected day slicing uses UTC boundaries.
- The tool needs a modern Chromium-based browser (uses `CompressionStream`).
- Confirm the engagement permits exporting the data before you run it on a
  client cluster.
