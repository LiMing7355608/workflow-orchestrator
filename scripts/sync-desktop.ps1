param(
  [Parameter(Mandatory)]
  [string] $Destination,
  [switch] $UseExistingBuild
)

$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$destinationPath = [IO.Path]::GetFullPath($Destination).TrimEnd('\', '/')
$installParent = (Resolve-Path -LiteralPath (Split-Path -Parent $destinationPath)).Path
$destinationPath = Join-Path $installParent (Split-Path -Leaf $destinationPath)
$source = Join-Path $repository 'apps\desktop\out\WorkflowOrchestrator-win32-x64'
$exe = 'workflow-orchestrator.exe'

if ((Split-Path -Leaf $destinationPath) -ne 'WorkflowOrchestrator-win32-x64' -or
    $destinationPath -eq $source -or $destinationPath.StartsWith($repository + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw '请选择仓库外的 WorkflowOrchestrator-win32-x64 安装目录。'
}
if (Test-Path -LiteralPath $destinationPath) {
  $item = Get-Item -LiteralPath $destinationPath
  if ((($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or
      !(Test-Path -LiteralPath (Join-Path $destinationPath $exe) -PathType Leaf)) {
    throw '目标目录需要是常规 WorkflowOrchestrator 安装包。'
  }
}
if ($env:AGENT_DATA_DIR) {
  $dataPath = [IO.Path]::GetFullPath($env:AGENT_DATA_DIR)
  if ($dataPath -eq $destinationPath -or $dataPath.StartsWith($destinationPath + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw '请先将 AGENT_DATA_DIR 指向安装目录外的数据目录。'
  }
}

if (!$UseExistingBuild) {
  Push-Location -LiteralPath $repository
  try {
    & pnpm desktop:make
    if ($LASTEXITCODE -ne 0) { throw '桌面打包失败。' }
  } finally { Pop-Location }
}

$fromSource = @{
  'resources\server\dist\main.js' = 'packages\server\dist\main.js'
  'resources\web\index.html' = 'packages\web\dist\index.html'
  'resources\server\node_modules\@orchestrator\core\dist\index.js' = 'packages\core\dist\index.js'
  'resources\server\node_modules\@orchestrator\planner\dist\index.js' = 'packages\planner\dist\index.js'
}
function Get-Digest([string] $Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}
foreach ($file in $fromSource.Keys) {
  if ((Get-Digest (Join-Path $source $file)) -ne (Get-Digest (Join-Path $repository $fromSource[$file]))) {
    throw "构建产物已经过期，请重新打包。$file"
  }
}

$suffix = [Guid]::NewGuid().ToString('N')
$stage = Join-Path $installParent ('.workflow-desktop-stage-' + $suffix)
$backup = Join-Path $installParent ('.workflow-desktop-previous-' + $suffix)
if ((Split-Path -Parent $stage) -ne $installParent -or (Split-Path -Parent $backup) -ne $installParent -or
    (Test-Path -LiteralPath $stage) -or (Test-Path -LiteralPath $backup)) {
  throw '暂存目录或备份目录无效。'
}

& robocopy $source $stage /E /XJ /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NP /NJH /NJS
if ($LASTEXITCODE -ge 8) { throw "无法复制桌面包。Robocopy $LASTEXITCODE" }
$fromPackage = @($exe, 'resources\app.asar') + @($fromSource.Keys)
foreach ($file in $fromPackage) {
  if ((Get-Digest (Join-Path $source $file)) -ne (Get-Digest (Join-Path $stage $file))) {
    throw "暂存的桌面包校验失败。$file"
  }
}
$activeExe = Join-Path $destinationPath $exe
$running = Get-CimInstance Win32_Process -Filter "Name='$exe'" | Where-Object { $_.ExecutablePath -eq $activeExe }
if ($running) { throw '原安装目录里的程序正在运行。关闭窗口后重新同步。' }

$hadInstall = Test-Path -LiteralPath $destinationPath
if ($hadInstall) { Move-Item -LiteralPath $destinationPath -Destination $backup }
try {
  Move-Item -LiteralPath $stage -Destination $destinationPath
} catch {
  if ($hadInstall) { Move-Item -LiteralPath $backup -Destination $destinationPath }
  throw
}
Write-Output "本机桌面已更新：$activeExe"
if ($hadInstall) { Write-Output "旧包备份：$backup" }
