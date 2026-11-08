function Import-MiganNative {
 param([string]$Root,[string]$Name,[string]$Source)
 function Assert-PlainPath([string]$Path) {
  $item=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  while($null -ne $item) {
   if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Native artifact reparse blocked'}
   $parent=Split-Path -Parent $item.FullName
   if(!$parent -or $parent -eq $item.FullName){break}
   $item=Get-Item -LiteralPath $parent -Force -ErrorAction Stop
  }
 }
 function Get-BytesHash([byte[]]$Bytes) {
  $sha=[Security.Cryptography.SHA256]::Create()
  try{return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
 }
 if($Name -notin @('appcontainer','windows-job','mcp-job','process-identity')){throw 'Invalid native artifact name'}
 $project=[IO.Path]::GetFullPath((Join-Path $Root '../..')).ToLowerInvariant()
 $key=Get-BytesHash ([Text.Encoding]::UTF8.GetBytes($project))
 $data=$env:APPDATA
 if(!$data){$data=Join-Path $env:USERPROFILE 'AppData/Roaming'}
 $dir=Join-Path $data ('migan-workbench/native/'+$key.Substring(0,24))
 $pointer=Join-Path $project 'src/recovery/native/location.json'
 if(Test-Path -LiteralPath $pointer){
  Assert-PlainPath $pointer
  $location=[IO.File]::ReadAllText($pointer) | ConvertFrom-Json
  if($location.kind -ne 'migango-local-native-location/v1' -or $location.checkout -ne $key.Substring(0,24) -or ![IO.Path]::IsPathRooted($location.directory)){throw 'Invalid native location; rebuild required'}
  $dir=$location.directory
 }
 if(Test-Path -LiteralPath (Join-Path $dir '.build-lock')){throw 'Native build in progress; retry after setup completes'}
 $manifest=Join-Path $dir ($Name+'.json')
 $assembly=Join-Path $dir ($Name+'.dll')
 Assert-PlainPath $manifest
 Assert-PlainPath $assembly
 $meta=[IO.File]::ReadAllText($manifest) | ConvertFrom-Json
 if($meta.sourceSha256 -notmatch '^[a-f0-9]{64}$' -or $meta.assemblySha256 -notmatch '^[a-f0-9]{64}$'){throw 'Invalid native artifact manifest'}
 $Source=$Source.Replace("`r`n","`n")
 if($Name -ne 'process-identity'){
  $common=Join-Path $project 'src/recovery/native-job-tree.cs'
  Assert-PlainPath $common
  $Source=$Source+"`n// MIGANGO_SHARED_JOB_TREE_V1`n"+[IO.File]::ReadAllText($common).Replace("`r`n","`n")
 }
 $actual=Get-BytesHash ([Text.Encoding]::UTF8.GetBytes($Source))
 if($actual -ne $meta.sourceSha256){throw 'Native source hash mismatch; rebuild required'}
 # Verify and load the same bytes; never reopen an unverified assembly path.
 $bytes=[IO.File]::ReadAllBytes($assembly)
 if((Get-BytesHash $bytes) -ne $meta.assemblySha256){throw 'Native assembly hash mismatch; rebuild required'}
 Add-Type -AssemblyName System.Web.Extensions
 [void][Reflection.Assembly]::Load($bytes)
}
