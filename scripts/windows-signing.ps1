$ErrorActionPreference = "Stop"
if (!$env:ARTIFACT_SIGNING_CLIENT_VERSION -or $env:ARTIFACT_SIGNING_CLIENT_VERSION -notmatch '^\d+\.\d+\.\d+$') {
    throw "Set ARTIFACT_SIGNING_CLIENT_VERSION to a tested exact Microsoft.Trusted.Signing.Client NuGet version"
}
if (!$env:ARTIFACT_SIGNING_ENDPOINT -or !$env:ARTIFACT_SIGNING_ACCOUNT -or !$env:ARTIFACT_SIGNING_PROFILE) {
    throw "Configure the Microsoft Artifact Signing endpoint, account and certificate profile"
}
$dir = Join-Path $env:RUNNER_TEMP "artifact-signing"
New-Item -ItemType Directory -Path $dir -Force | Out-Null
$version = $env:ARTIFACT_SIGNING_CLIENT_VERSION
$uri = "https://api.nuget.org/v3-flatcontainer/microsoft.trusted.signing.client/$version/microsoft.trusted.signing.client.$version.nupkg"
Invoke-WebRequest $uri -OutFile "$dir\client.zip"
Expand-Archive "$dir\client.zip" "$dir\client" -Force
# x64 SDK and dlib also run under Windows 11 ARM64 emulation.
$tool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" |
    Sort-Object FullName -Descending | Select-Object -First 1
$dlib = Get-ChildItem "$dir\client" -Recurse -Filter "Azure.CodeSigning.Dlib.dll" |
    Where-Object FullName -Match '\\x64\\' | Select-Object -First 1
if (!$tool -or !$dlib) { throw "Required x64 SignTool and Artifact Signing dlib are missing" }
$metadata = @{
    Endpoint=$env:ARTIFACT_SIGNING_ENDPOINT
    CodeSigningAccountName=$env:ARTIFACT_SIGNING_ACCOUNT
    CertificateProfileName=$env:ARTIFACT_SIGNING_PROFILE
    ExcludeCredentials=@("EnvironmentCredential","WorkloadIdentityCredential","ManagedIdentityCredential","SharedTokenCacheCredential","VisualStudioCredential","VisualStudioCodeCredential","AzurePowerShellCredential","AzureDeveloperCliCredential","InteractiveBrowserCredential")
}
$metadata | ConvertTo-Json | Set-Content "$dir\metadata.json" -Encoding utf8
"SIGNTOOL=$($tool.FullName)" >> $env:GITHUB_ENV
"WINDOWS_SIGNING_DLIB=$($dlib.FullName)" >> $env:GITHUB_ENV
"WINDOWS_SIGNING_METADATA=$dir\metadata.json" >> $env:GITHUB_ENV
