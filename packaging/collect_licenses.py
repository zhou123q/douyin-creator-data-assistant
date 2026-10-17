from __future__ import annotations

import re
import shutil
import sys
from importlib.metadata import distributions
from pathlib import Path


def main(destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    rows = [
        "# Python dependency license inventory",
        "",
        "Generated from the isolated Windows build environment. Review this inventory and each bundled component's terms before redistribution.",
        "License files collected by this script are stored under `third_party_licenses/`.",
        "",
        "| Package | Version | Declared license | License files found |",
        "| --- | --- | --- | --- |",
    ]
    license_dir = destination / "third_party_licenses"
    license_dir.mkdir(parents=True, exist_ok=True)
    found_any = 0

    for dist in sorted(distributions(), key=lambda item: (item.metadata.get("Name") or "").lower()):
        name = dist.metadata.get("Name", "unknown")
        version = dist.version
        declared = dist.metadata.get("License-Expression") or dist.metadata.get("License") or ""
        if not declared:
            classifiers = [
                item.rsplit("::", 1)[-1].strip()
                for item in dist.metadata.get_all("Classifier", [])
                if "License ::" in item
            ]
            declared = "; ".join(classifiers) or "Not declared in package metadata"

        candidates = []
        for item in dist.files or []:
            basename = Path(str(item)).name.lower()
            if basename.startswith(("license", "licence", "copying", "notice", "thirdpartynotices")):
                source = Path(dist.locate_file(item))
                if source.is_file():
                    candidates.append((source, str(item).replace("\\", "/")))

        package_target = license_dir / f"{re.sub(r'[^A-Za-z0-9._-]+', '_', name)}-{version}"
        copied = []
        for source, relative in candidates:
            target = package_target / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            copied.append(relative)
            found_any += 1

        files_summary = ", ".join(f"`{Path(item).name}`" for item in copied) or "None found"
        rows.append(f"| {name} | {version} | {declared.replace('|', '/')} | {files_summary} |")

    if not found_any:
        raise RuntimeError("No dependency license files were found")
    (destination / "THIRD_PARTY_NOTICES.md").write_text("\n".join(rows) + "\n", encoding="utf-8")
    print(f"Collected {found_any} license/notice files into {license_dir}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: collect_licenses.py DESTINATION")
    main(Path(sys.argv[1]).resolve())
