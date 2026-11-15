# Compila (e opcionalmente testa) o app iOS no MacBook Air pela rede (ver D:\Code\mac\README.md).
# Uso (PowerShell, na Dell):
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\build-on-mac.ps1 [-Destination simulator|device] [-Test] [-Install <idDoAparelho>]
#
# O project.yml inclui o ThermalPrinterKit como pacote local pelo caminho relativo da pasta vizinha
# (../../../../ThermalPrinterKit/ios a partir de mobile/ios, ou seja D:\Code\ThermalPrinterKit no Dell). Para o mesmo
# caminho valer no Mac, o script reproduz esse layout dentro de $RemoteDir/src: o app vai para
# src/wabotia/Wabotia/mobile/ios e o kit para src/ThermalPrinterKit/ios. Tudo fica dentro de $RemoteDir.
param(
  [string]$MacHost = "mac",
  [string]$RemoteDir = "~/wabotia-ios",
  [ValidateSet("simulator", "device")] [string]$Destination = "device",
  [string]$Simulator = "Vinki v4 iPad",
  [string]$KitDir = "",
  [switch]$Test,
  [string]$Install = ""
)
$ErrorActionPreference = "Stop"
$local = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $KitDir) { $KitDir = Join-Path $local "..\..\..\..\ThermalPrinterKit" }
$KitDir = (Resolve-Path $KitDir).Path
if (-not (Test-Path (Join-Path $KitDir "ios\Package.swift"))) { throw "ThermalPrinterKit nao encontrado em $KitDir (use -KitDir)." }

$app = "src/wabotia/Wabotia/mobile/ios"
$kit = "src/ThermalPrinterKit/ios"
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("wabotia-ios-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Output "Empacotando fontes do app e do kit ($KitDir)..."
  # So as fontes: sem build/, .build/ nem o .xcodeproj gerado.
  tar -cf (Join-Path $tmp "app.tar") -C $local project.yml Wabotia WabotiaTests
  if ($LASTEXITCODE -ne 0) { throw "tar do app falhou" }
  tar -cf (Join-Path $tmp "kit.tar") --exclude ".build" --exclude ".swiftpm" --exclude "xcuserdata" --exclude "*.xcodeproj" -C (Join-Path $KitDir "ios") .
  if ($LASTEXITCODE -ne 0) { throw "tar do kit falhou" }

  Write-Output "Copiando para ${MacHost}:$RemoteDir ..."
  ssh -o BatchMode=yes $MacHost "mkdir -p $RemoteDir/.upload"
  scp -o BatchMode=yes -q (Join-Path $tmp "app.tar") (Join-Path $tmp "kit.tar") "${MacHost}:$RemoteDir/.upload/"
  if ($LASTEXITCODE -ne 0) { throw "scp falhou" }
  # As pastas de fontes remotas sao recriadas a cada vez, para espelhar este checkout (nada sobra de outro branch).
  ssh -o BatchMode=yes $MacHost "cd $RemoteDir && rm -rf $app/Wabotia $app/WabotiaTests $kit && mkdir -p $app $kit && tar -xf .upload/app.tar -C $app && tar -xf .upload/kit.tar -C $kit && rm -rf .upload"
  if ($LASTEXITCODE -ne 0) { throw "extracao no Mac falhou" }
} finally {
  Remove-Item -Recurse -Force $tmp
}

$dest = if ($Destination -eq "simulator") { "platform=iOS Simulator,name=$Simulator" } else { 'generic/platform=iOS' }
$action = if ($Test) { "test" } else { "build" }
if ($Test -and $Destination -ne "simulator") { $dest = "platform=iOS Simulator,name=$Simulator" }
$log = "$RemoteDir/build-$action.log"
$cmd = "export PATH=/opt/homebrew/bin:`$PATH; cd $RemoteDir/$app && xcodegen generate >/dev/null && ~/bin/xcb -scheme Wabotia -destination '$dest' -derivedDataPath $RemoteDir/build $action > $log 2>&1; rc=`$?; grep -E 'error:|Executed [0-9]+ tests|Test Case .* failed' $log | sort -u | head -n 60; tail -n 5 $log; exit `$rc"
Write-Output "Executando '$action' no Mac ($dest)..."
ssh -o BatchMode=yes $MacHost $cmd
$status = $LASTEXITCODE
if ($Install -and $status -eq 0) {
  Write-Output "Instalando no aparelho $Install ..."
  $built = "$RemoteDir/build/Build/Products/Debug-iphoneos/Wabotia.app"
  ssh -o BatchMode=yes $MacHost "xcrun devicectl device install app --device $Install $built || ios-deploy --id $Install --bundle $built --no-wifi"
}
exit $status
