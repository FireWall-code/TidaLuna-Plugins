# Embeds the freshly built 32-bit .node as base64 into the plugin's native-bin.ts.
# Run from smtc-bridge/ after build32.bat.
$node = Join-Path $PSScriptRoot "smtc-bridge.win32-ia32-msvc.node"
$out  = Join-Path $PSScriptRoot "..\plugins\tidal-shuffle-repeat\src\native-bin.ts"
if (-not (Test-Path $node)) { Write-Error "Build the addon first (build32.bat) — $node not found"; exit 1 }
$b = [Convert]::ToBase64String([IO.File]::ReadAllBytes($node))
$header = "// AUTO-GENERATED — base64 of smtc-bridge.win32-ia32-msvc.node. Do not edit by hand.`r`n"
$body = 'export const NATIVE_IA32_BASE64 = "' + $b + '";' + "`r`n"
[IO.File]::WriteAllText($out, $header + $body)
Write-Output "Embedded $($b.Length) base64 chars into $out"
