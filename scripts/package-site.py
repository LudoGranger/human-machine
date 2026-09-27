"""Rebuild the static setup prompt and portable skill download. Python 3 only."""

import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
skill = (ROOT / "skills/hm/SKILL.md").read_text(encoding="utf-8")
(SITE / "skill-data.js").write_text(
    "// Generated from skills/hm/SKILL.md by scripts/package-site.py.\n"
    + "window.HM_SKILL_SOURCE = " + json.dumps(skill, ensure_ascii=True) + ";\n",
    encoding="utf-8",
)

# Public allowlist: package skills only, never the runtime or working directory.
files = {
    "README.md": ROOT / "docs/SKILLS.md",
    "LICENSE": ROOT / "LICENSE",
    "manifest.json": ROOT / "manifest.json",
    "scripts/install.mjs": ROOT / "scripts/install.mjs",
}
manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
for name in manifest["skills"]:
    directory = ROOT / "skills" / name
    if directory.is_symlink() or directory.resolve().parent != (ROOT / "skills").resolve():
        raise ValueError(f"Invalid skill directory: {name}")
    for path in directory.rglob("*.md"):
        files[path.relative_to(ROOT).as_posix()] = path
archive = SITE / "human-machine-skills.zip"
with ZipFile(archive, "w", compression=ZIP_DEFLATED) as bundle:
    for name, path in sorted(files.items()):
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"Expected a regular package file: {path}")
        entry = ZipInfo("human-machine/" + name)
        entry.compress_type = ZIP_DEFLATED
        entry.external_attr = 0o100644 << 16
        bundle.writestr(entry, path.read_bytes())

print(f"Updated setup prompt and {archive.name} ({len(files)} files).")
