#!/usr/bin/env python3
"""
PUBLIC_INTERFACE
extract_figma_assets.py

This script parses a Figma screen JSON (as provided in attachments) to detect all image/icon
components (PNG, JPG, SVG/Vector) and extracts or downloads the real assets to an assets folder.

It supports:
- Direct "imageUrl" fields on nodes (downloads the raster image from Figma CDN).
- Local "imagePath" fields (copies into target assets dir if present).
- Icon/vector nodes (figma_type VECTOR or type 'icon'): creates minimal SVG placeholders based
  on node name and dimensions when no URL is available in the JSON (since raw Figma API is not
  available without a fileKey and node id list).

If you have a Figma API token and file key, you can optionally pass them to download true SVGs
for vector nodes using Figma's 'images' endpoint. See usage for details.

Usage:
  python scripts/extract_figma_assets.py \
      --input-json ../../../attachments/screen_371:365.json \
      --assets-dir ../../../assets/figmaimages \
      [--figma-token YOUR_FIGMA_TOKEN] \
      [--file-key YOUR_FILE_KEY]

Notes:
- Do not hard-code secrets. If you use --figma-token, provide it via environment variable or CLI.
- The script will create the assets directory if it doesn't exist.
- The script will write a manifest JSON detailing extracted assets.

Environment variables (optional):
- FIGMA_TOKEN: Your Figma Personal Access Token if you want to fetch real SVGs for vectors.
- FIGMA_FILE_KEY: Figma file key if you want to fetch real SVGs for vectors.

Outputs:
- Downloaded PNG/JPG assets to assets-dir
- Copied local assets referenced via imagePath (if they exist)
- Generated SVG placeholders for icons (or real SVGs if Figma API details are provided)
- A manifest file: assets-dir/figma_assets_manifest.json

Author: Kavia Code Generation Agent
"""
import argparse
import json
import os
import re
import shutil
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlencode
import urllib.request

# -----------------------------
# Helper utilities
# -----------------------------

def ensure_dir(p: Path) -> None:
    """Ensure directory exists."""
    p.mkdir(parents=True, exist_ok=True)

def slugify(text: str) -> str:
    """Make a safe filename slug."""
    text = text.strip().lower()
    text = re.sub(r"[^a-z0-9._-]+", "-", text)
    text = re.sub(r"-{2,}", "-", text)
    return text.strip("-") or "asset"

def fetch_binary(url: str, timeout: int = 30) -> bytes:
    """Fetch binary content from a URL."""
    req = urllib.request.Request(url, headers={"User-Agent": "asset-extractor/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()

def write_binary(path: Path, data: bytes) -> None:
    """Write binary data to file."""
    ensure_dir(path.parent)
    with open(path, "wb") as f:
        f.write(data)

def write_text(path: Path, data: str) -> None:
    """Write text data to file."""
    ensure_dir(path.parent)
    with open(path, "w", encoding="utf-8") as f:
        f.write(data)

def load_json(path: Path) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def save_json(path: Path, obj: Any) -> None:
    ensure_dir(path.parent)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2)

def is_vector_node(node: Dict[str, Any]) -> bool:
    """Heuristic: types that represent vectors/icons from this JSON."""
    if node.get("figma_type") == "VECTOR":
        return True
    if node.get("type") == "icon":
        return True
    # Some vector-like instances may be frames containing icons
    return False

def node_dimensions(node: Dict[str, Any]) -> Tuple[Optional[float], Optional[float]]:
    dims = node.get("dimensions") or {}
    return dims.get("width"), dims.get("height")

def node_identifier(node: Dict[str, Any]) -> str:
    """Build a helpful identifier for filenames."""
    nid = node.get("id", "node")
    name = node.get("name", "node")
    base = f"{name}_{nid}".replace(" ", "_")
    return slugify(base)

# -----------------------------
# Figma API helpers (optional)
# -----------------------------

def figma_images_api_url(file_key: str, ids: List[str], fmt: str = "svg") -> str:
    # https://www.figma.com/developers/api#get-images-endpoint
    base = f"https://api.figma.com/v1/images/{file_key}"
    q = urlencode({"ids": ",".join(ids), "format": fmt})
    return f"{base}?{q}"

def figma_fetch_images(file_key: str, ids: List[str], token: str, fmt: str = "svg") -> Dict[str, str]:
    """
    Calls Figma images endpoint to get URLs for node IDs.
    Returns mapping id -> image URL.
    """
    url = figma_images_api_url(file_key, ids, fmt=fmt)
    req = urllib.request.Request(url, headers={"X-Figma-Token": token})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data.get("images") or {}

# -----------------------------
# Core extraction logic
# -----------------------------

def traverse_nodes(root: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Flatten all nodes with DFS."""
    result: List[Dict[str, Any]] = []
    stack = [root]
    while stack:
        n = stack.pop()
        result.append(n)
        for c in n.get("children", []) or []:
            stack.append(c)
    return result

def extract_assets(
    screen_json_path: Path,
    assets_dir: Path,
    figma_token: Optional[str] = None,
    file_key: Optional[str] = None,
) -> Dict[str, Any]:
    """
    PUBLIC_INTERFACE
    Extracts assets from a Figma screen JSON to a given assets directory.

    Returns a manifest dictionary describing extracted assets.
    """
    manifest: Dict[str, Any] = {
        "source_json": str(screen_json_path),
        "assets_dir": str(assets_dir),
        "downloaded": [],
        "copied": [],
        "generated_svg": [],
        "skipped": [],
    }

    data = load_json(screen_json_path)
    root = data.get("root")
    if not root:
        print("No 'root' key found in JSON. Nothing to extract.", file=sys.stderr)
        return manifest

    ensure_dir(assets_dir)
    nodes = traverse_nodes(root)

    # Collect vector node ids for optional Figma real SVG download
    vector_node_ids: List[str] = [n.get("id") for n in nodes if is_vector_node(n) and n.get("id")]

    figma_images_map: Dict[str, str] = {}
    if figma_token and file_key and vector_node_ids:
        try:
            # Limit batch size to avoid URL length issues
            batched: List[str] = []
            for nid in vector_node_ids:
                batched.append(nid)
                if len(batched) >= 90:
                    figma_images_map.update(figma_fetch_images(file_key, batched, figma_token, fmt="svg"))
                    batched = []
            if batched:
                figma_images_map.update(figma_fetch_images(file_key, batched, figma_token, fmt="svg"))
            print(f"Fetched {len(figma_images_map)} vector SVG URLs from Figma API.")
        except Exception as ex:
            print(f"Warning: Unable to fetch real SVGs via Figma API: {ex}", file=sys.stderr)

    for node in nodes:
        ntype = node.get("type", "").lower()
        ftype = node.get("figma_type", "").upper()
        nid = node.get("id")
        nname = node.get("name", "")
        ident = node_identifier(node)

        # 1) If imageUrl present: download it (PNG/JPG etc.)
        image_url = node.get("imageUrl")
        if image_url:
            ext = Path(image_url).suffix
            if ext.lower() not in [".png", ".jpg", ".jpeg", ".gif", ".webp"]:
                # default to .png if not obvious
                ext = ".png"
            out_path = assets_dir / f"{ident}{ext}"
            try:
                data = fetch_binary(image_url)
                write_binary(out_path, data)
                manifest["downloaded"].append({"node_id": nid, "name": nname, "path": str(out_path), "source": image_url})
                continue
            except Exception as ex:
                manifest["skipped"].append({"node_id": nid, "name": nname, "reason": f"download_error: {ex}"})
                continue

        # 2) If imagePath present and exists (local file inside repo), copy it
        image_path = node.get("imagePath")
        if image_path:
            # imagePath may be absolute from project root; normalize relative to repo root
            # Repo root is three levels up from this script: task-management-web-app-41-54/
            repo_root = Path(__file__).resolve().parents[3]
            candidate = (repo_root / image_path.lstrip("/")).resolve()
            try:
                if candidate.exists() and candidate.is_file():
                    ext = candidate.suffix or ".png"
                    out_path = assets_dir / f"{ident}{ext}"
                    ensure_dir(out_path.parent)
                    shutil.copyfile(candidate, out_path)
                    manifest["copied"].append({"node_id": nid, "name": nname, "from": str(candidate), "to": str(out_path)})
                    continue
                else:
                    manifest["skipped"].append({"node_id": nid, "name": nname, "reason": f"imagePath_not_found: {candidate}"})
            except Exception as ex:
                manifest["skipped"].append({"node_id": nid, "name": nname, "reason": f"copy_error: {ex}"})
                continue

        # 3) Handle vector/icon nodes
        if is_vector_node(node):
            width, height = node_dimensions(node)
            # Prefer real SVG via Figma API if available
            svg_url = None
            if nid and figma_images_map.get(nid):
                svg_url = figma_images_map[nid]

            out_path = assets_dir / f"{ident}.svg"
            try:
                if svg_url:
                    svg_data = fetch_binary(svg_url)
                    write_binary(out_path, svg_data)
                    manifest["generated_svg"].append({"node_id": nid, "name": nname, "path": str(out_path), "source": "figma_api"})
                else:
                    # Generate a placeholder SVG with correct size and name as metadata.
                    w = width or 24
                    h = height or 24
                    placeholder = f"""<?xml version="1.0" encoding="UTF-8"?>
<svg width="{w}" height="{h}" viewBox="0 0 {w} {h}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="{nname}">
  <title>{nname}</title>
  <rect x="0.5" y="0.5" width="{max(w-1, 0)}" height="{max(h-1, 0)}" fill="none" stroke="#999" stroke-dasharray="4 2"/>
  <text x="4" y="{(h or 24) - 6}" font-family="Arial, Helvetica, sans-serif" font-size="8" fill="#666">{nname or 'icon'}</text>
</svg>
"""
                    write_text(out_path, placeholder)
                    manifest["generated_svg"].append({"node_id": nid, "name": nname, "path": str(out_path), "source": "placeholder"})
                continue
            except Exception as ex:
                manifest["skipped"].append({"node_id": nid, "name": nname, "reason": f"svg_error: {ex}"})
                continue

        # 4) Other node types: nothing to extract
        # Could be rectangles/text/lines etc. Skip.
        # Keep informational skip record for icons without data.
        if ntype in ("rectangle", "text", "line", "ellipse", "container", "component"):
            continue

    # Save manifest
    manifest_path = assets_dir / "figma_assets_manifest.json"
    save_json(manifest_path, manifest)
    print(f"Extraction complete. Manifest written to {manifest_path}")
    return manifest

def main():
    parser = argparse.ArgumentParser(description="Extract assets from a Figma screen JSON into assets directory.")
    parser.add_argument("--input-json", required=True, help="Path to the Figma screen JSON file.")
    parser.add_argument("--assets-dir", required=True, help="Target assets directory to save images/icons.")
    parser.add_argument("--figma-token", default=os.getenv("FIGMA_TOKEN"), help="Figma API token (optional).")
    parser.add_argument("--file-key", default=os.getenv("FIGMA_FILE_KEY"), help="Figma file key (optional).")
    args = parser.parse_args()

    input_json = Path(args.input_json).resolve()
    assets_dir = Path(args.assets_dir).resolve()

    if not input_json.exists():
        print(f"Input JSON not found: {input_json}", file=sys.stderr)
        sys.exit(1)

    extract_assets(input_json, assets_dir, figma_token=args.figma_token, file_key=args.file_key)

if __name__ == "__main__":
    main()
"""
