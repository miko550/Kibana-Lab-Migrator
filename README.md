# Kibana Lab Migrator

Tools for migrating an Elasticsearch/Kibana dataset from one cluster to another,
built for labs where access is limited to Kibana (Dev Tools) or direct
Elasticsearch. Exporting is read-only — it never writes to or deletes from the
source.

Three tools, two export routes + one loader:

- `kibana-lab-migrator.js` / `.bookmarklet.txt` — export from **inside a Kibana
  tab**, through the console proxy. No API key or CLI needed, just your Kibana
  login. Use when you only have Kibana.
- `load_dataset.sh` — restore a bundle (plain indices **and** data streams) onto
  a target cluster.

---

## Export route A — inside Kibana (bookmarklet / console)

### Install (bookmarklet)
1. Create any bookmark in Chrome, then edit it.
2. Replace its URL with the entire contents of `kibana-lab-migrator.bookmarklet.txt`.
3. Name it "Lab Migrator".
4. Open a Kibana tab (any space) and click the bookmark — a panel appears top-right.

If the bookmark does nothing, the page CSP blocked it; use the console method.

### Install (console — always works)
1. In the Kibana tab, press F12 → Console.
2. Paste the entire contents of `kibana-lab-migrator.js` and press Enter.
3. The panel appears. (Chrome may ask you to type `allow pasting` first.)

### Use
The panel header shows cluster name, ES version, and your user — confirm it's the
right lab before anything.

1. **Select targets** from the list (system indices starting with `.` hidden;
   data streams are listed and detected automatically).
2. **Analyze selected** — pulls doc counts and detects the time field. Each target
   shows a dropdown to confirm or change it (or "no time field" to export whole).
   For data streams the timestamp field comes from the stream definition.
3. **Export** — streams each target to gzipped NDJSON in Downloads, split one file
   per UTC day (empty days skipped), each file count-verified against `_count`.
   On finish it also saves the **bundle** automatically (see below). Allow multiple
   downloads if Chrome prompts.
4. **Save mappings** — downloads just `mappings.json` (field types for plain
   indices). For inspection only; not enough on its own to restore.
5. **Save bundle (manifest+templates)** — downloads `manifest.txt`, `mappings.json`,
   and `templates__*.json` (data-stream templates + ILM), without re-pulling docs.
   This is what the loader needs.

---

## The bundle

Whichever export route you use, the result is a folder containing:

- `*.ndjson.gz` — the exported docs (one file per index, or per UTC day)
- `manifest.txt` — per target: `name`, count, time field, type (`index` /
  `data_stream`), template name. Tab-separated.
- `mappings.json` — field mappings for plain indices
- `templates/` (shell) or `templates__*.json` (bookmarklet) — index templates,
  component templates, and ILM policies for data streams

(The bookmarklet downloads flat files named `templates__index_template_*.json` etc.
Before running the loader, move them into a `templates/` subfolder and strip the
`templates__` prefix, or keep the shell exporter's layout.)

---

## Loading into the target cluster

```bash
chmod +x load_dataset.sh
./load_dataset.sh -u https://TARGET:9200 -k <API_KEY> -d ./out -i -K https://TARGET-KIBANA:5601
```

`load_dataset.sh` reads `manifest.txt` and branches per target:

- **Plain index** → create with its source mapping (bulk-load settings), load with
  elasticdump (or a curl `_bulk` fallback if elasticdump isn't installed), restore
  replica/refresh settings.
- **Data stream** → create its component templates, index template, and ILM policy,
  create the stream, then bulk-index with the `create` op data streams require.

Then it verifies every count against the manifest and, with `-K`, creates a Kibana
data view per target using the recorded time field.

Flags: `-k` or `-U`/`-P` auth · `-d` bundle dir (required) · `-K` Kibana URL for
data views · `-i` insecure TLS · `-c CA` · `-f` recreate existing targets ·
`-r N` replicas after load (use `-r 0` on a single node) · `-b N` batch size.
Needs `curl`, `jq`, `gzip`; `elasticdump` only for plain indices (optional).

`load_hunt_dataset.sh` (the original, mappings baked in for the five hunt indices)
is kept for that specific dataset; `load_dataset.sh` is the general one.

---

## Data streams

Detected and handled end to end with nothing extra to do — export captures the
templates + ILM that define the stream, the manifest marks it `data_stream`, and
the loader recreates it before bulk-loading with the `create` op. Verified end to
end against Elasticsearch 9.5.4 (plain index and data stream in one bundle).

---

## File naming

Daily files are named by the **UTC start date** of the window they cover, e.g.
`logs_network_2026-08-16.ndjson.gz` holds docs timestamped
2026-08-16 00:00 → 2026-08-17 00:00 UTC. A partial last day is smaller than the
rest. The per-day split is only for file size; the loader recombines all of an
index's files into one index on the target.

---

## Notes and limits

- The bookmarklet runs in the browser and is bound by tab memory. Daily splitting
  keeps files manageable, but a very high-volume single day can still be heavy.
  Keep the tab open and the machine awake during export. 
- `_id` is not preserved (only `_source` is exported); the target assigns fresh ids.
  Fine unless something references the original ids.
- Day slicing uses UTC boundaries.
- The bookmarklet needs a modern Chromium browser (`CompressionStream`).
- Confirm the engagement permits exporting the data before running on a client
  cluster.
