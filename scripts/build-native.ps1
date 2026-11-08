param([string]$Source,[string]$Output,[switch]$Executable)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
if($Executable){Add-Type -TypeDefinition ([IO.File]::ReadAllText($Source)) -ReferencedAssemblies System.Web.Extensions.dll -OutputAssembly $Output -OutputType ConsoleApplication}
else{Add-Type -TypeDefinition ([IO.File]::ReadAllText($Source)) -ReferencedAssemblies System.Web.Extensions.dll -OutputAssembly $Output}
