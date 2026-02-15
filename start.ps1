param(
  [switch]$OpenUI
)

Set-Location $PSScriptRoot

if ($OpenUI) {
  Start-Process "http://127.0.0.1:3434"
}

bun run server.ts
