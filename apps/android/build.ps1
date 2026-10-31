param(
  [string]$AndroidSdk = "$env:USERPROFILE\.rea\toolchains\android\sdk",
  [string]$JavaHome = "$env:USERPROFILE\.rea\toolchains\android\jdk-21",
  [switch]$SkipWebBuild,
  [switch]$DebugWebView,
  [string]$DebugCaCertificate = ''
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$cache = Join-Path $repository '.cache\android-build'
$run = Join-Path $cache ('run-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
$deps = Join-Path $cache 'deps'
$artifacts = Join-Path $cache 'artifacts'
$buildTools = Join-Path $AndroidSdk 'build-tools\35.0.0'
$androidJar = Join-Path $AndroidSdk 'platforms\android-35\android.jar'
$java = Join-Path $JavaHome 'bin\java.exe'
$javac = Join-Path $JavaHome 'bin\javac.exe'
$jar = Join-Path $JavaHome 'bin\jar.exe'
$keytool = Join-Path $JavaHome 'bin\keytool.exe'
foreach ($required in @($androidJar, $java, $javac, (Join-Path $buildTools 'aapt.exe'))) { if (!(Test-Path -LiteralPath $required)) { throw "Missing Android build tool: $required" } }
function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
  & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Build command failed: $Executable (exit $LASTEXITCODE)" }
}
New-Item -ItemType Directory -Force -Path $run,$deps,$artifacts,(Join-Path $run 'assets\web'),(Join-Path $run 'classes'),(Join-Path $run 'dex'),(Join-Path $run 'generated\app\vivic\remote') | Out-Null
$zxing = Join-Path $deps 'zxing-core-3.5.3.jar'
$zxingHash = '8d8064c1636fdaef7189dd9055c7d59950a8940a12f2293956446ec3c109fd82'
if (!(Test-Path -LiteralPath $zxing)) { Invoke-WebRequest -UseBasicParsing -Uri 'https://repo.maven.apache.org/maven2/com/google/zxing/core/3.5.3/core-3.5.3.jar' -OutFile $zxing }
if ((Get-FileHash -LiteralPath $zxing -Algorithm SHA256).Hash.ToLowerInvariant() -ne $zxingHash) { throw 'ZXing dependency checksum mismatch; refusing build.' }
if (!$SkipWebBuild) {
  Push-Location $repository
  try { Invoke-Checked 'corepack' @('pnpm','--filter','@vivic/web','build:mobile') } finally { Pop-Location }
}
$web = Join-Path $repository 'contrib\mobile-console\dist-ui'
if (!(Test-Path -LiteralPath (Join-Path $web 'index.html'))) { throw 'Missing mobile build. Run without -SkipWebBuild.' }
Copy-Item -LiteralPath (Join-Path $web 'index.html') -Destination (Join-Path $run 'assets\web\index.html')
Copy-Item -LiteralPath (Join-Path $web 'assets') -Destination (Join-Path $run 'assets\web\assets') -Recurse
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'licenses') -Destination (Join-Path $run 'assets\licenses') -Recurse
$utf8 = [System.Text.UTF8Encoding]::new($false)
if ($DebugCaCertificate -and !$DebugWebView) { throw 'A test CA can only be included with -DebugWebView. Production builds never add trust anchors.' }
$manifestPath = Join-Path $PSScriptRoot 'AndroidManifest.xml'
$resourcePath = Join-Path $PSScriptRoot 'res'
if ($DebugCaCertificate) {
  $testCa = (Resolve-Path -LiteralPath $DebugCaCertificate).Path
  $resourcePath = Join-Path $run 'debug-res'
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'res') -Destination $resourcePath -Recurse
  New-Item -ItemType Directory -Force -Path (Join-Path $resourcePath 'raw'),(Join-Path $resourcePath 'xml') | Out-Null
  Copy-Item -LiteralPath $testCa -Destination (Join-Path $resourcePath 'raw\vivic_test_ca.pem')
  [System.IO.File]::WriteAllText((Join-Path $resourcePath 'xml\vivic_test_network_security.xml'), '<network-security-config><base-config cleartextTrafficPermitted="false"><trust-anchors><certificates src="system" /></trust-anchors></base-config><debug-overrides><trust-anchors><certificates src="@raw/vivic_test_ca" /></trust-anchors></debug-overrides></network-security-config>', $utf8)
  [xml]$debugManifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8
  $debugManifest.manifest.application.SetAttribute('debuggable', 'http://schemas.android.com/apk/res/android', 'true') | Out-Null
  $debugManifest.manifest.application.SetAttribute('networkSecurityConfig', 'http://schemas.android.com/apk/res/android', '@xml/vivic_test_network_security') | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $run 'debug-manifest') | Out-Null
  $manifestPath = Join-Path $run 'debug-manifest\AndroidManifest.xml'
  $debugManifest.Save($manifestPath)
}
$debugValue = if ($DebugWebView) { 'true' } else { 'false' }
[System.IO.File]::WriteAllText((Join-Path $run 'generated\app\vivic\remote\BuildConfig.java'), "package app.vivic.remote; public final class BuildConfig { public static final boolean DEBUG_WEBVIEW = $debugValue; }", $utf8)
$sources = @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'src') -Recurse -Filter '*.java' | ForEach-Object FullName)
$sources += Join-Path $run 'generated\app\vivic\remote\BuildConfig.java'
Invoke-Checked $javac (@('-encoding','UTF-8','-source','8','-target','8','-classpath',"$androidJar;$zxing",'-d',(Join-Path $run 'classes')) + $sources)
Invoke-Checked $jar @('--create','--file',(Join-Path $run 'app.jar'),'-C',(Join-Path $run 'classes'),'.')
Invoke-Checked $java @('-cp',(Join-Path $buildTools 'lib\d8.jar'),'com.android.tools.r8.D8','--release','--min-api','26','--lib',$androidJar,'--output',(Join-Path $run 'dex'),(Join-Path $run 'app.jar'),$zxing)
$unsigned = Join-Path $run 'unsigned.apk'
Invoke-Checked (Join-Path $buildTools 'aapt.exe') @('package','-f','-M',$manifestPath,'-S',$resourcePath,'-A',(Join-Path $run 'assets'),'-I',$androidJar,'-F',$unsigned)
Invoke-Checked $jar @('--update','--file',$unsigned,'-C',(Join-Path $run 'dex'),'classes.dex')
$aligned = Join-Path $run 'aligned.apk'
Invoke-Checked (Join-Path $buildTools 'zipalign.exe') @('-f','4',$unsigned,$aligned)
$keystore = Join-Path $cache 'vivic-development.p12'
if (!(Test-Path -LiteralPath $keystore)) { Invoke-Checked $keytool @('-genkeypair','-keystore',$keystore,'-storetype','PKCS12','-storepass','android','-alias','vivic-development','-keyalg','RSA','-keysize','3072','-validity','3650','-dname','CN=Vivic Local Development') }
[xml]$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'AndroidManifest.xml') -Raw -Encoding UTF8
$version = $manifest.manifest.GetAttribute('versionName', 'http://schemas.android.com/apk/res/android')
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid Android version name' }
$name = 'Vivic-Remote-' + $version + $(if ($DebugWebView) { '-debug.apk' } else { '.apk' })
$apk = Join-Path $artifacts $name
Invoke-Checked $java @('-jar',(Join-Path $buildTools 'lib\apksigner.jar'),'sign','--ks',$keystore,'--ks-key-alias','vivic-development','--ks-pass','pass:android','--out',$apk,$aligned)
Invoke-Checked $java @('-jar',(Join-Path $buildTools 'lib\apksigner.jar'),'verify','--verbose',$apk)
$receipt = [ordered]@{ builtAt = (Get-Date).ToUniversalTime().ToString('o'); apk = $name; sha256 = (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLowerInvariant(); runtime = 'Android native scanner + bundled WebView controller'; minSdk = 26; targetSdk = 35; debugging = [bool]$DebugWebView; testCa = [bool]$DebugCaCertificate; signing = 'local-development'; zxing = @{ version = '3.5.3'; sha256 = $zxingHash }; webAssets = @(Get-ChildItem -LiteralPath (Join-Path $run 'assets\web') -File -Recurse | ForEach-Object { @{ path = $_.FullName.Substring((Join-Path $run 'assets\web').Length + 1); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() } }) }
[System.IO.File]::WriteAllText((Join-Path $artifacts ($name + '.json')), ($receipt | ConvertTo-Json -Depth 5), $utf8)
Write-Output "APK ready: $apk"
