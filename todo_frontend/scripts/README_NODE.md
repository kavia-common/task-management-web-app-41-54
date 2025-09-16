# Figma Asset Extraction (Node.js)

This script extracts icons and images from a Figma screen JSON and writes them to the project's assets directory. It can optionally use the Figma Images API to download actual SVGs for vector nodes when credentials are provided.

## What it does

- Parses a Figma screen JSON (e.g., attachments/screen_371:365.json).
- Detects:
  - Raster images referenced via `imageUrl` (downloads them).
  - Local images referenced via `imagePath` (copies them).
  - Icons/vectors (nodes with `figma_type: "VECTOR"` or `type: "icon"`).
- For vector/icon nodes:
  - If you provide Figma API credentials (`FIGMA_TOKEN` and `FIGMA_FILE_KEY`), it downloads real SVGs via Figma's `images` API.
  - Otherwise, it generates placeholder SVGs with correct dimensions.

All assets and a manifest are written to the target assets directory.

## Requirements

- Node.js 16+ (recommended)
- Internet access (if using `imageUrl` or the Figma API)

## Usage

From the repo root:

```bash
node task-management-web-app-41-54/todo_frontend/scripts/extract_figma_assets.js \
  attachments/screen_371:365.json \
  --out assets/figmaimages
```

This will:
- Download any images found under `imageUrl`.
- Copy any local files found under `imagePath` (if they exist).
- Generate placeholder SVGs for icon/vector nodes unless Figma API credentials are provided.

You should see outputs in `assets/figmaimages/` and a manifest at:
`assets/figmaimages/figma_assets_manifest.json`.

## Optional: Real SVGs via Figma API

If you have a Figma personal access token and a corresponding file key, you can fetch real SVGs for vector nodes.

Set environment variables:

```bash
export FIGMA_TOKEN=YOUR_FIGMA_TOKEN
export FIGMA_FILE_KEY=YOUR_FILE_KEY
```

Or pass them via CLI flags:

```bash
node task-management-web-app-41-54/todo_frontend/scripts/extract_figma_assets.js \
  attachments/screen_371:365.json \
  --out assets/figmaimages \
  --token "$FIGMA_TOKEN" \
  --file-key "$FIGMA_FILE_KEY"
```

Notes:
- The JSON must contain `id` values for nodes that correspond to the file specified by `FIGMA_FILE_KEY`.
- Without valid IDs and file key, Figma will not return image URLs for vectors. In that case, the script will generate placeholder SVGs.

## NPM Script

You can also add an npm script entry to run the Node extractor. Example:

```json
{
  "scripts": {
    "extract:figma:node": "node ./scripts/extract_figma_assets.js ../../attachments/screen_371:365.json --out ../../assets/figmaimages"
  }
}
```

Run it:

```bash
npm --prefix task-management-web-app-41-54/todo_frontend run extract:figma:node
```

## Output Manifest

`assets/figmaimages/figma_assets_manifest.json` contains:
- `downloaded`: assets fetched via `imageUrl`.
- `copied`: assets copied from local `imagePath`.
- `generated_svg`: SVGs either fetched via API or placeholder-generated.
- `skipped`: nodes that could not be processed (with reasons).

## Troubleshooting

- "Input JSON not found": Ensure the path provided to the script is correct relative to your current working directory.
- "imagePath_not_found": The local file referenced does not exist in the repo.
- No SVGs downloaded for vectors: Provide valid `FIGMA_TOKEN` and `FIGMA_FILE_KEY`. Otherwise placeholders are expected.

## Security

- Do not hard-code your Figma token. Use environment variables or CI secrets.
- The script reads `FIGMA_TOKEN` and `FIGMA_FILE_KEY` from environment variables unless provided via CLI flags.
