#!/usr/bin/env python3
"""
Fetch one sample from HuggingFace xcodemind/Figma2Code and save to src/data.
Uses streaming mode to avoid loading/downloading full split metadata.

Usage:
  python scripts/fetch_figma2code_sample.py
  python scripts/fetch_figma2code_sample.py --split test
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from datasets import load_dataset


def safe_node_id(node_id: str) -> str:
    return node_id.replace(":", "-").replace("/", "_")


def ensure_json(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    return value


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Download one Figma2Code sample into src/data (streaming single-row fetch)"
    )
    parser.add_argument("--split", default="test", help="Dataset split: test/rest")
    parser.add_argument(
        "--output-dir",
        default="src/data/figma2code",
        help="Base output directory"
    )
    args = parser.parse_args()

    dataset = load_dataset("xcodemind/Figma2Code", split=args.split, streaming=True)
    row = next(iter(dataset), None)
    if row is None:
        raise IndexError(f"no rows found for split '{args.split}'")
    filekey = str(row.get("filekey", "unknown"))
    node_id = str(row.get("node_id", "unknown"))
    sample_id = f"{filekey}_{safe_node_id(node_id)}"

    sample_dir = Path(args.output_dir) / sample_id
    sample_dir.mkdir(parents=True, exist_ok=True)

    # Save screenshot image
    root_image = row["root"]
    root_image.save(sample_dir / "root.png")

    # Save metadata JSON
    raw_metadata = ensure_json(row.get("raw_metadata"))
    processed_metadata = ensure_json(row.get("processed_metadata"))
    statistics = ensure_json(row.get("statistics"))

    with (sample_dir / "raw_metadata.json").open("w", encoding="utf-8") as f:
        json.dump(raw_metadata, f, ensure_ascii=False, indent=2)
    with (sample_dir / "processed_metadata.json").open("w", encoding="utf-8") as f:
        json.dump(processed_metadata, f, ensure_ascii=False, indent=2)

    # Save core sample summary for quick inspection / pipeline inputs
    sample_summary = {
        "id": sample_id,
        "split": args.split,
        "index": 0,
        "filekey": filekey,
        "node_id": node_id,
        "page_url": row.get("page_url"),
        "annotation": row.get("annotation"),
        "statistics": statistics,
        "screenshotPath": str((sample_dir / "root.png").resolve()),
        "rawMetadataPath": str((sample_dir / "raw_metadata.json").resolve()),
        "processedMetadataPath": str((sample_dir / "processed_metadata.json").resolve()),
    }
    with (sample_dir / "sample.json").open("w", encoding="utf-8") as f:
        json.dump(sample_summary, f, ensure_ascii=False, indent=2)

    print("Saved Figma2Code sample:")
    print(f"  sample_id: {sample_id}")
    print(f"  dir:       {sample_dir.resolve()}")
    print("  files:     root.png, raw_metadata.json, processed_metadata.json, sample.json")


if __name__ == "__main__":
    main()
