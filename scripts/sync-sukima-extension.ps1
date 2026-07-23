<#
.SYNOPSIS
    正式ソース (chrome-extension/) を、Chromeが読み込んでいる動作フォルダへ同期する。

.DESCRIPTION
    コピー元: D:\09_AI_Projects\perfact\chrome-extension
    コピー先: C:\Users\tetsu\Projectssukima-sidepanel

    拡張機能ID (dhanoojabkccbaecnkikaadionedabpn) を維持するため、
    Chromeの読み込み元フォルダ自体は変更せず、フォルダ内のファイルだけを同期する。

    実行前に、コピー先フォルダ全体を C:\Users\tetsu\Projectssukima-sidepanel-backup へ
    バックアップする。バックアップ先が既に存在する場合は上書きせず停止する。

    同期対象は以下8ファイルのみ。ファイル削除・Chrome操作は一切行わない。
      - manifest.json
      - background.js
      - sidepanel.html
      - sidepanel.js
      - sidepanel.css
      - icon-16.png
      - icon-48.png
      - icon-128.png
#>

$ErrorActionPreference = "Stop"

$SourceDir  = "D:\09_AI_Projects\perfact\chrome-extension"
$DestDir    = "C:\Users\tetsu\Projectssukima-sidepanel"
$BackupDir  = "C:\Users\tetsu\Projectssukima-sidepanel-backup"

$SyncFiles = @(
    "manifest.json",
    "background.js",
    "sidepanel.html",
    "sidepanel.js",
    "sidepanel.css",
    "icon-16.png",
    "icon-48.png",
    "icon-128.png"
)

function Get-FileHashSafe {
    param(
        [string]$Path
    )
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    }
    return $null
}

Write-Host "=== スキマ Chrome拡張 同期スクリプト ===" -ForegroundColor Cyan

# 1. コピー元・コピー先の存在確認
if (-not (Test-Path -LiteralPath $SourceDir -PathType Container)) {
    Write-Error "コピー元フォルダが存在しません: $SourceDir"
    exit 1
}
if (-not (Test-Path -LiteralPath $DestDir -PathType Container)) {
    Write-Error "コピー先フォルダが存在しません: $DestDir"
    exit 1
}
Write-Host "[OK] コピー元・コピー先の存在を確認しました。" -ForegroundColor Green

# 2. コピー前に8ファイルのSHA256を表示
Write-Host ""
Write-Host "=== コピー前 SHA256 ===" -ForegroundColor Cyan
foreach ($file in $SyncFiles) {
    $srcPath  = Join-Path $SourceDir $file
    $destPath = Join-Path $DestDir $file

    $srcHash  = Get-FileHashSafe -Path $srcPath
    $destHash = Get-FileHashSafe -Path $destPath

    if ($null -eq $srcHash) {
        Write-Error "コピー元に必要なファイルがありません: $srcPath"
        exit 1
    }

    $destHashDisplay = if ($null -ne $destHash) { $destHash } else { "(コピー先に未存在)" }

    Write-Host "$file"
    Write-Host "  src : $srcHash"
    Write-Host "  dest: $destHashDisplay"
}

# 3. コピー先を丸ごとバックアップする
# 4. バックアップ先が既に存在する場合は上書きせず停止
Write-Host ""
Write-Host "=== バックアップ ===" -ForegroundColor Cyan
if (Test-Path -LiteralPath $BackupDir) {
    Write-Error "バックアップ先が既に存在するため停止します: $BackupDir"
    exit 1
}

Copy-Item -LiteralPath $DestDir -Destination $BackupDir -Recurse
Write-Host "[OK] コピー先をバックアップしました: $BackupDir" -ForegroundColor Green

# 5. 指定8ファイルだけをコピー
Write-Host ""
Write-Host "=== ファイルコピー ===" -ForegroundColor Cyan
foreach ($file in $SyncFiles) {
    $srcPath  = Join-Path $SourceDir $file
    $destPath = Join-Path $DestDir $file
    Copy-Item -LiteralPath $srcPath -Destination $destPath -Force
    Write-Host "  コピー完了: $file"
}

# 6. コピー後にSHA256を比較
# 7. 8ファイルすべて一致した場合だけ成功表示
# 8. 不一致の場合はエラー終了
Write-Host ""
Write-Host "=== コピー後 SHA256 比較 ===" -ForegroundColor Cyan
$allMatched = $true
foreach ($file in $SyncFiles) {
    $srcPath  = Join-Path $SourceDir $file
    $destPath = Join-Path $DestDir $file

    $srcHash  = Get-FileHashSafe -Path $srcPath
    $destHash = Get-FileHashSafe -Path $destPath

    if ($srcHash -eq $destHash) {
        Write-Host "[OK]   $file  $srcHash"
    } else {
        Write-Host "[DIFF] $file  src=$srcHash dest=$destHash" -ForegroundColor Red
        $allMatched = $false
    }
}

Write-Host ""
if ($allMatched) {
    Write-Host "=== 成功: 8ファイルすべて一致しました ===" -ForegroundColor Green
    Write-Host "バックアップ: $BackupDir"
    exit 0
} else {
    Write-Error "=== 失敗: コピー後のハッシュが一致しないファイルがあります ==="
    exit 1
}

# 9. ファイル削除は行わない（このスクリプトはRemove-Itemを一切使用しない）
# 10. Chrome操作は行わない（このスクリプトはChromeプロセス・拡張機能APIに一切触れない）
