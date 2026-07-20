# 보이스노트 로컬 정적 서버 (HttpListener)
# 사용: powershell -NoProfile -ExecutionPolicy Bypass -File server.ps1 [-Port 8788] [-OpenBrowser]
param(
    [int]$Port = 8788,
    [switch]$OpenBrowser
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$mime = @{
    ".html" = "text/html; charset=utf-8"
    ".htm"  = "text/html; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".js"   = "application/javascript; charset=utf-8"
    ".mjs"  = "application/javascript; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".webmanifest" = "application/manifest+json; charset=utf-8"
    ".svg"  = "image/svg+xml"
    ".png"  = "image/png"
    ".jpg"  = "image/jpeg"
    ".jpeg" = "image/jpeg"
    ".gif"  = "image/gif"
    ".ico"  = "image/x-icon"
    ".wav"  = "audio/wav"
    ".mp3"  = "audio/mpeg"
    ".m4a"  = "audio/mp4"
    ".aac"  = "audio/aac"
    ".ogg"  = "audio/ogg"
    ".webm" = "audio/webm"
    ".woff" = "font/woff"
    ".woff2" = "font/woff2"
    ".txt"  = "text/plain; charset=utf-8"
    ".md"   = "text/plain; charset=utf-8"
}

# 포트가 사용 중이면 +1 하며 최대 10회 재시도
$listener = $null
$tries = 0
while ($tries -lt 10) {
    $listener = New-Object System.Net.HttpListener
    $listener.Prefixes.Add("http://localhost:$Port/")
    try {
        $listener.Start()
        break
    } catch {
        Write-Host "포트 $Port 사용 중 → $($Port + 1) 시도"
        $listener.Close()
        $listener = $null
        $Port++
        $tries++
    }
}
if ($null -eq $listener) {
    Write-Host "사용 가능한 포트를 찾지 못했습니다." -ForegroundColor Red
    exit 1
}

$url = "http://localhost:$Port/"
Write-Host ""
Write-Host "  보이스노트 서버 실행 중: $url" -ForegroundColor Green
Write-Host "  중지하려면 이 창을 닫거나 Ctrl+C 를 누르세요."
Write-Host ""

if ($OpenBrowser) { Start-Process $url }

while ($listener.IsListening) {
    try {
        $context = $listener.GetContext()
    } catch {
        break
    }
    $req = $context.Request
    $res = $context.Response
    try {
        $path = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath)
        if ($path -eq "/") { $path = "/index.html" }
        # 경로 탈출 방지
        $file = Join-Path $root ($path -replace "/", "\")
        $fullFile = [System.IO.Path]::GetFullPath($file)
        if (-not $fullFile.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
            $res.StatusCode = 403
        } elseif (Test-Path $fullFile -PathType Leaf) {
            $ext = [System.IO.Path]::GetExtension($fullFile).ToLower()
            $type = $mime[$ext]
            if ($null -eq $type) { $type = "application/octet-stream" }
            $bytes = [System.IO.File]::ReadAllBytes($fullFile)
            $res.ContentType = $type
            $res.Headers.Add("Cache-Control", "no-cache")
            $res.ContentLength64 = $bytes.Length
            $res.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $res.StatusCode = 404
            $msg = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $path")
            $res.ContentType = "text/plain; charset=utf-8"
            $res.ContentLength64 = $msg.Length
            $res.OutputStream.Write($msg, 0, $msg.Length)
        }
    } catch {
        try { $res.StatusCode = 500 } catch {}
    } finally {
        try { $res.OutputStream.Close() } catch {}
    }
}
$listener.Stop()
