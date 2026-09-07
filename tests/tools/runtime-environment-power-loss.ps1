param(
  [Parameter(Mandatory=$true)][guid]$VmId,
  [Parameter(Mandatory=$true)][string]$VmName,
  [Parameter(Mandatory=$true)][string]$CredentialPath,
  [Parameter(Mandatory=$true)][string]$GuestRoot,
  [ValidateSet('before','after')][string[]]$Writers = @('before','after'),
  [ValidateRange(1,10)][int]$Pairs = 1,
  [ValidateRange(640,65536)][int]$PayloadBytes = 640,
  [ValidateRange(1,100)][int]$CompletedBeforeCut = 4
)

$ErrorActionPreference = 'Stop'
$credential = Import-Clixml -LiteralPath $CredentialPath
if ($credential -isnot [System.Management.Automation.PSCredential]) {
  throw 'The credential file does not contain a PSCredential'
}
$runDirectory = Join-Path $PSScriptRoot ('power-loss-run-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runDirectory | Out-Null
$script:summary = @()

function Write-Event([string]$Name, [object]$Data) {
  $record = [ordered]@{ event=$Name; utc=[DateTime]::UtcNow.ToString('o'); data=$Data }
  $line = $record | ConvertTo-Json -Depth 8 -Compress
  [IO.File]::AppendAllText((Join-Path $runDirectory 'host-events.jsonl'), $line + [Environment]::NewLine)
  Write-Output $line
}

function Connect-Guest {
  $deadline = [DateTime]::UtcNow.AddSeconds(180)
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      return New-PSSession -VMId $vmId -Credential $credential -ErrorAction Stop
    } catch {
      Start-Sleep -Seconds 3
    }
  }
  throw 'PowerShell Direct did not become ready within 180 seconds'
}

function Collect-WriterEvents($Job, $Events, [string]$LogPath) {
  $output = @(Receive-Job -Job $Job -ErrorAction SilentlyContinue)
  foreach ($item in $output) {
    if ($item -isnot [string] -or -not $item.StartsWith('{')) { continue }
    try { $event = $item | ConvertFrom-Json } catch { continue }
    if (-not $event.event) { continue }
    [void]$Events.Add($event)
    [IO.File]::AppendAllText($LogPath, $item + [Environment]::NewLine)
  }
}

Write-Event 'run-start' @{ runDirectory=$runDirectory; vmId=$vmId.ToString(); vmName=$VmName; guestRoot=$GuestRoot; writers=$Writers; pairs=$Pairs; payloadBytes=$PayloadBytes; completedBeforeCut=$CompletedBeforeCut }

for ($pair = 1; $pair -le $Pairs; $pair++) {
  $variants = @($Writers)
  if ($pair % 2 -eq 0) { [array]::Reverse($variants) }
  foreach ($variant in $variants) {
    $tag = '{0:d2}-{1}' -f $pair,$variant
    $session = $null
    $job = $null
    $restoreVm = $false
    try {
      $vm = Get-VM -Id $vmId
      if ($vm.Name -cne $VmName) { throw 'VM name and ID do not match' }
      $restoreVm = $true
      if ($vm.State -eq 'Off') { Start-VM -VM $vm | Out-Null }
      if ((Get-VM -Id $vmId).State -ne 'Running') { throw 'Test VM is not running' }
      $session = Connect-Guest
      $bootAge = Invoke-Command -Session $session -ScriptBlock {
        ((Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime).TotalSeconds
      }
      $settleSeconds = [Math]::Max(0, [Math]::Ceiling(90 - $bootAge))
      if ($settleSeconds -gt 0) {
        Write-Event 'boot-settle' @{ tag=$tag; seconds=$settleSeconds }
        Start-Sleep -Seconds $settleSeconds
      }
      $probePath = Join-Path $GuestRoot ('power-loss-' + $variant + '.cjs')
      $nodePath = Join-Path $GuestRoot 'node.exe'
      Write-Event 'trial-start' @{ tag=$tag; variant=$variant }
      $guestDetails = Invoke-Command -Session $session -ArgumentList $nodePath,$probePath -ScriptBlock {
        param($NodePath,$ProbePath)
        [pscustomobject]@{
          computer=$env:COMPUTERNAME
          windowsVersion=[Environment]::OSVersion.Version.ToString()
          nodeVersion=(& $NodePath --version)
          nodeSha256=(Get-FileHash -LiteralPath $NodePath -Algorithm SHA256).Hash
          probeSha256=(Get-FileHash -LiteralPath $ProbePath -Algorithm SHA256).Hash
        }
      }
      Write-Event 'guest-details' @{ tag=$tag; details=$guestDetails }
      $events = New-Object System.Collections.ArrayList
      $eventLog = Join-Path $runDirectory ($tag + '-writer.jsonl')
      $job = Invoke-Command -Session $session -AsJob -ArgumentList $nodePath,$probePath,$PayloadBytes -ScriptBlock {
        param($NodePath,$ProbePath,$PayloadBytes)
        & $NodePath $ProbePath write $PayloadBytes
        if ($LASTEXITCODE -ne 0) { throw 'The guest writer failed' }
      }
      $deadline = [DateTime]::UtcNow.AddSeconds(90)
      while ([DateTime]::UtcNow -lt $deadline) {
        Collect-WriterEvents $job $events $eventLog
        $completed = @($events | Where-Object event -eq 'write-complete')
        if ($completed.Count -ge $CompletedBeforeCut) { break }
        if ($job.State -in @('Completed','Failed','Stopped')) { throw 'Writer ended before the cut threshold' }
        Start-Sleep -Milliseconds 25
      }
      $completed = @($events | Where-Object event -eq 'write-complete')
      $ready = $events | Where-Object event -eq 'ready' | Select-Object -First 1
      if (-not $ready -or $completed.Count -lt $CompletedBeforeCut) { throw 'No complete write evidence arrived before the deadline' }
      if ($events | Where-Object event -eq 'batch-complete') { throw 'Writer finished before power-off' }
      Write-Event 'power-off-request' @{ tag=$tag; completedWrites=$completed.Count; guestRoot=$ready.root }
      $stopwatch = [Diagnostics.Stopwatch]::StartNew()
      Stop-VM -VM (Get-VM -Id $vmId) -TurnOff -Confirm:$false -ErrorAction Stop
      $stopwatch.Stop()
      if ((Get-VM -Id $vmId).State -ne 'Off') { throw 'Hyper-V did not confirm the VM is off' }
      Collect-WriterEvents $job $events $eventLog
      Write-Event 'power-off-confirmed' @{ tag=$tag; durationMs=$stopwatch.ElapsedMilliseconds; state='Off' }
      $manifestPath = Join-Path $runDirectory ($tag + '-manifest.json')
      $manifest = @{ root=$ready.root; events=@($events.ToArray()) }
      [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
      Remove-PSSession -Session $session -ErrorAction SilentlyContinue
      $session = $null
      Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
      $job = $null
      Start-VM -VM (Get-VM -Id $vmId) | Out-Null
      $session = Connect-Guest
      $guestManifest = Join-Path $GuestRoot ($tag + '-' + (Split-Path $runDirectory -Leaf) + '.json')
      Copy-VMFile -VM (Get-VM -Id $vmId) -SourcePath $manifestPath -DestinationPath $guestManifest -FileSource Host -CreateFullPath -ErrorAction Stop
      $inspectionOutput = Invoke-Command -Session $session -ArgumentList $nodePath,(Join-Path $GuestRoot 'power-loss-after.cjs'),$guestManifest -ScriptBlock {
        param($NodePath,$ProbePath,$ManifestPath)
        & $NodePath $ProbePath inspect $ManifestPath
        if ($LASTEXITCODE -ne 0) { throw 'The guest inspection failed' }
      }
      $inspectionText = ($inspectionOutput | Where-Object { $_ -is [string] }) -join [Environment]::NewLine
      $inspection = $inspectionText | ConvertFrom-Json
      if ($inspection.event -ne 'inspection') { throw 'Missing raw inspection result' }
      [IO.File]::WriteAllText((Join-Path $runDirectory ($tag + '-inspection.json')), $inspectionText, (New-Object Text.UTF8Encoding($false)))
      $result = [ordered]@{ tag=$tag; variant=$variant; payloadBytes=$PayloadBytes; completedWrites=$inspection.completedWrites; counts=$inspection.counts; powerOffDurationMs=$stopwatch.ElapsedMilliseconds }
      $script:summary += [pscustomobject]$result
      [IO.File]::WriteAllText((Join-Path $runDirectory 'summary.json'), (ConvertTo-Json -InputObject @($script:summary) -Depth 8), (New-Object Text.UTF8Encoding($false)))
      Write-Event 'trial-result' $result
    } finally {
      if ($job) { Remove-Job -Job $job -Force -ErrorAction SilentlyContinue }
      if ($session) { Remove-PSSession -Session $session -ErrorAction SilentlyContinue }
      if ($restoreVm -and (Get-VM -Id $vmId).State -eq 'Off') { Start-VM -VM (Get-VM -Id $vmId) | Out-Null }
    }
  }
}
Write-Event 'run-complete' @{ runDirectory=$runDirectory; trials=$script:summary.Count; finalVmState=(Get-VM -Id $vmId).State.ToString() }
