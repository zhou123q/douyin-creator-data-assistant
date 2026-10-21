$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$companionSource = Join-Path $root "build\release\df_local_asr"
$buildRoot = Join-Path $root "build\release_bundle"
$bundleName = "DF抖音创作者数据助手_1.10.4_Windows"
$bundle = Join-Path $buildRoot $bundleName
$zipPath = Join-Path $buildRoot "$bundleName.zip"
$companionTarget = Join-Path $bundle "本地伴侣\df_local_asr"

if (-not (Test-Path (Join-Path $companionSource "df_local_asr.exe"))) {
    throw "Build the companion first: $companionSource"
}
if (Test-Path $bundle) { Remove-Item -LiteralPath $bundle -Recurse -Force }
if (Test-Path $zipPath) { Remove-Item -LiteralPath $zipPath -Force }

New-Item -ItemType Directory -Force $bundle, (Join-Path $bundle "浏览器插件"), $companionTarget | Out-Null
$extension = Join-Path $bundle "浏览器插件"
$rootFiles = @(
    "LICENSE", "manifest.json", "background.js", "inject.js",
    "monitor_entry.js", "monitor_offscreen.html", "monitor_offscreen.js",
    "monitor.css", "monitor.html", "monitor.js", "monitor_worker.js",
    "popup.html", "popup.js"
)
foreach ($file in $rootFiles) { Copy-Item -LiteralPath (Join-Path $root $file) -Destination $extension }
foreach ($directory in @("icons", "libs", "modules")) {
    Copy-Item -LiteralPath (Join-Path $root $directory) -Destination $extension -Recurse
}
Copy-Item -Path (Join-Path $companionSource "*") -Destination $companionTarget -Recurse
Remove-Item -LiteralPath (Join-Path $companionTarget "config.json") -Force -ErrorAction SilentlyContinue

$python = Join-Path $root "local_asr\.venv\Scripts\python.exe"
if (-not (Test-Path $python)) { throw "Build virtual environment is missing: $python" }
& $python (Join-Path $PSScriptRoot "collect_licenses.py") (Join-Path $bundle "本地伴侣")
if ($LASTEXITCODE -ne 0) { throw "Third-party license collection failed" }

Copy-Item -LiteralPath (Join-Path $PSScriptRoot "start_companion.bat") -Destination (Join-Path $bundle "本地伴侣\启动本地伴侣.bat")
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "QUICK_START.md") -Destination (Join-Path $bundle "README_快速安装.md")
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "THIRD_PARTY_WEB_NOTICES.md") -Destination (Join-Path $bundle "THIRD_PARTY_WEB_NOTICES.md")
Copy-Item -LiteralPath (Join-Path $root "README.md") -Destination (Join-Path $bundle "README_项目说明.md")

$zipper = @'
import os
import sys
import zipfile

source, destination, archive_root = sys.argv[1:]
with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for current, directories, files in os.walk(source):
        directories.sort()
        files.sort()
        relative_dir = os.path.relpath(current, os.path.dirname(source))
        if not directories and not files:
            archive.writestr(relative_dir.replace(os.sep, "/") + "/", "")
        for filename in files:
            path = os.path.join(current, filename)
            relative_path = os.path.relpath(path, os.path.dirname(source))
            archive.write(path, relative_path.replace(os.sep, "/"))
'@
& $python -c $zipper $bundle $zipPath $bundleName
if ($LASTEXITCODE -ne 0) { throw "UTF-8 ZIP creation failed" }
$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
"ZIP: $zipPath`nSHA256: $hash"
