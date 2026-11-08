# Compila o app iOS no MacBook Air pela rede (ver D:\Code\mac\README.md).
# Uso (PowerShell, na Dell):  powershell -NoProfile -ExecutionPolicy Bypass -File .\build-on-mac.ps1 [-Destination simulator|device] [-Install <idDoAparelho>]
param(
  [string]$MacHost = "mac",
  [string]$RemoteDir = "~/wabotia-ios",
  [ValidateSet("simulator", "device")] [string]$Destination = "device",
  [string]$Install = ""
)
$ErrorActionPreference = "Stop"
$local = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Output "Copiando $local para $MacHost:$RemoteDir ..."
ssh -o BatchMode=yes $MacHost "mkdir -p $RemoteDir"
# Copia só as fontes (sem build/ nem .xcodeproj gerado).
$items = @("project.yml", "Wabotia", "WabotiaTests")
foreach ($item in $items) { scp -o BatchMode=yes -r (Join-Path $local $item) "${MacHost}:$RemoteDir/" }
$dest = if ($Destination -eq "simulator") { 'platform=iOS Simulator,name=Vinki v4 iPad' } else { 'generic/platform=iOS' }
$cmd = "export PATH=/opt/homebrew/bin:`$PATH; cd $RemoteDir && xcodegen generate && ~/bin/xcb -scheme Wabotia -destination '$dest' -derivedDataPath build build 2>&1 | tail -n 40"
Write-Output "Compilando no Mac ($Destination)..."
ssh -o BatchMode=yes $MacHost $cmd
if ($Install) {
  Write-Output "Instalando no aparelho $Install ..."
  ssh -o BatchMode=yes $MacHost "cd $RemoteDir && xcrun devicectl device install app --device $Install build/Build/Products/Debug-iphoneos/Wabotia.app || ios-deploy --id $Install --bundle build/Build/Products/Debug-iphoneos/Wabotia.app --no-wifi"
}
