param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$ArgumentsBase64,
    [Parameter(Mandatory = $true)][string]$StdoutFile,
    [Parameter(Mandatory = $true)][string]$StderrFile,
    [Parameter(Mandatory = $true)][string]$MetricsFile
)

$ErrorActionPreference = 'Stop'
$argumentsJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgumentsBase64))
$childArguments = @($argumentsJson | ConvertFrom-Json)
$startInfo = [Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $Executable
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
foreach ($argument in $childArguments) {
    [void]$startInfo.ArgumentList.Add([string]$argument)
}

$process = [Diagnostics.Process]::new()
$process.StartInfo = $startInfo
$startedAt = [Diagnostics.Stopwatch]::StartNew()
[void]$process.Start()
$stdoutStream = [IO.File]::Open($StdoutFile, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::Read)
$stderrStream = [IO.File]::Open($StderrFile, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::Read)
$stdoutTask = $process.StandardOutput.BaseStream.CopyToAsync($stdoutStream)
$stderrTask = $process.StandardError.BaseStream.CopyToAsync($stderrStream)
$peakRssBytes = [int64]0
do {
    $process.Refresh()
    $peakRssBytes = [Math]::Max($peakRssBytes, [int64]$process.WorkingSet64)
    $exited = $process.WaitForExit(10)
} while (-not $exited)
$process.WaitForExit()
$stdoutTask.Wait()
$stderrTask.Wait()
$stdoutStream.Dispose()
$stderrStream.Dispose()
$startedAt.Stop()
$process.Refresh()

$metrics = [ordered]@{
    wallClockMs = [Math]::Round($startedAt.Elapsed.TotalMilliseconds, 3)
    cpuMs = [Math]::Round($process.TotalProcessorTime.TotalMilliseconds, 3)
    peakRssBytes = $peakRssBytes
    exitCode = [int]$process.ExitCode
}
[IO.File]::WriteAllText($MetricsFile, ($metrics | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
exit $process.ExitCode
