# SpecDriven installer for Windows -- specs/app/installation.feature.md
# "install on Windows from PowerShell".
#
#   irm https://raw.githubusercontent.com/SpecDriven/specdriven-app/main/install.ps1 | iex
#
# The PowerShell twin of install.sh. SpecDriven ships as a source zip so you
# can put the code through your own security checks before building it. This
# script downloads the zip of a release from
# https://github.com/SpecDriven/specdriven-app, checks that the release's
# SHASUMS256.txt is signed by the SpecDriven release key (the public half is
# below) and that the zip matches it, unpacks it under
# %USERPROFILE%\.specdriven\app, builds the desktop app with Bun, adds it to
# the Start menu and starts it.
# If Bun is missing it offers to install it, and installs it only if you say
# yes; without Bun it stops after unpacking and says what to run by hand.
#
# To read the code before any of it runs, take the zip from the releases page
# instead and unpack it yourself -- this script is the unattended path. How
# to verify a release by hand, with ssh-keygen or `gh attestation verify`, is
# in docs/installation.md.
#
# Environment overrides:
#   SPECDRIVEN_VERSION       release to install, e.g. 0.1.40   (default: latest)
#   SPECDRIVEN_HOME          install prefix                     (default: %USERPROFILE%\.specdriven)
#   SPECDRIVEN_RELEASES_URL  where the releases are             (default: the GitHub releases page)
#   SPECDRIVEN_INSTALL_BUN   answer the Bun question up front   (default: ask; 1 installs, 0 skips)
#   BUN_INSTALL              where Bun would go                 (default: %USERPROFILE%\.bun)
#   SPECDRIVEN_BUN_INSTALLER_URL  Bun's installer               (default: https://bun.sh/install.ps1)
#   SPECDRIVEN_RELEASE_PUBKEY  the key releases must be signed with (default: the one below;
#                            for installing from a release server of your own)
#
# Written for Windows PowerShell 5.1, which every Windows 10 and 11 has, and
# PowerShell 7. ASCII only: 5.1 reads a script file without a BOM in the
# legacy code page, so anything wider would come out garbled.

# One script block, so `irm | iex` -- which runs the text in the caller's own
# scope -- leaves no variables or preferences behind in their session.
& {
  $ErrorActionPreference = 'Stop'
  # 5.1 redraws a progress bar per chunk, which makes downloads crawl.
  $ProgressPreference = 'SilentlyContinue'

  # `exit` under `iex` would close the user's PowerShell window, so a failure
  # only sets the exit code when this runs as a script file.
  $asFile = [bool]$PSCommandPath

  # $IsWindows only exists from PowerShell 6; 5.1 runs on nothing else.
  $onWindows = ($PSVersionTable.PSEdition -eq 'Desktop') -or $IsWindows

  function Say([string]$message) { Write-Host $message }

  function Fail([string]$message) { throw [System.InvalidOperationException]::new($message) }

  # Plain strings only: a path or URL reaching Invoke-WebRequest or New-Item
  # must not be read as a wildcard.
  function Download([string]$url, [string]$path) {
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $path
  }

  # Scratch directories, removed however the run ends. A list rather than
  # variables, so the functions below can add to it from their own scope.
  $scratch = [System.Collections.Generic.List[string]]::new()

  try {
    # 5.1 on an older Windows still offers TLS 1.0 first; GitHub refuses it.
    if ($PSVersionTable.PSEdition -eq 'Desktop') {
      [Net.ServicePointManager]::SecurityProtocol =
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    }

    $releasesUrl = if ($env:SPECDRIVEN_RELEASES_URL) { $env:SPECDRIVEN_RELEASES_URL } else {
      'https://github.com/SpecDriven/specdriven-app/releases'
    }
    $releasesUrl = $releasesUrl.TrimEnd('/')
    $prefix = if ($env:SPECDRIVEN_HOME) { $env:SPECDRIVEN_HOME } else { Join-Path $HOME '.specdriven' }
    $appDir = Join-Path $prefix 'app'
    $version = if ($env:SPECDRIVEN_VERSION) { $env:SPECDRIVEN_VERSION } else { 'latest' }
    if ($version.StartsWith('v')) { $version = $version.Substring(1) }

    # The SpecDriven release signing key, the same line install.sh carries:
    # .github/workflows/release.yml signs each release's SHASUMS256.txt with
    # its private half (an SSH signature, as release@specdriven.app in the
    # "specdriven-release" namespace) and checks the result against it.
    $signerKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIdkUdY/iFmbDwh8/NPieR+Wkrx/vaAzXXf1+L5jovKx'
    $signer = 'release@specdriven.app'
    $signatureNamespace = 'specdriven-release'
    $trustedKey = if ($env:SPECDRIVEN_RELEASE_PUBKEY) { $env:SPECDRIVEN_RELEASE_PUBKEY } else { $signerKey }

    # --- pick a signature verifier ------------------------------------------

    # The checksum file is signed, so a release cannot be swapped for one that
    # merely comes with a matching checksum. The signature is an SSH
    # signature, which ssh-keygen verifies on its own: Windows 10 and 11 ship
    # it with the OpenSSH Client, on PATH or under System32\OpenSSH.
    $sshKeygen = Get-Command ssh-keygen -CommandType Application -ErrorAction SilentlyContinue |
      Select-Object -First 1 -ExpandProperty Source
    if (-not $sshKeygen -and $env:SystemRoot) {
      $builtIn = Join-Path $env:SystemRoot 'System32\OpenSSH\ssh-keygen.exe'
      if (Test-Path -LiteralPath $builtIn) { $sshKeygen = $builtIn }
    }
    if (-not $sshKeygen) {
      Fail ("need ssh-keygen to verify the release signature. On Windows it is the OpenSSH Client: " +
        "Settings > System > Optional features, or `Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0`.")
    }

    # ssh-keygen reads what was signed from stdin. Through .NET's Process, so
    # the bytes go in as downloaded: a PowerShell pipeline would re-encode
    # them and add a newline, and the signature covers every byte.
    function Test-Signature([string]$allowedSigners, [string]$signaturePath, [string]$signedPath) {
      $psi = New-Object System.Diagnostics.ProcessStartInfo
      $psi.FileName = $sshKeygen
      $quoted = @('-Y', 'verify', '-f', $allowedSigners, '-I', $signer, '-n', $signatureNamespace, '-s', $signaturePath) |
        ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }
      $psi.Arguments = $quoted -join ' '
      $psi.UseShellExecute = $false
      $psi.RedirectStandardInput = $true
      $psi.RedirectStandardOutput = $true
      $psi.RedirectStandardError = $true
      $process = [System.Diagnostics.Process]::Start($psi)
      try {
        $bytes = [System.IO.File]::ReadAllBytes($signedPath)
        try {
          $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
          $process.StandardInput.Close()
        } catch {
          # It stopped reading -- an ssh-keygen that gave up before looking
          # at stdin. Its exit code and its words, below, say why.
        }
        $output = $process.StandardOutput.ReadToEnd() + $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        return @{ ok = ($process.ExitCode -eq 0); output = $output.Trim() }
      } finally {
        $process.Dispose()
      }
    }

    if (-not $onWindows) {
      Say 'This installer is written for Windows; on macOS and Linux, install.sh is the one to use.'
    }

    # --- resolve the version --------------------------------------------------

    # Digits and dots only, three fields: anything else is a mistyped override,
    # a redirect that went somewhere unexpected, or a tag this script was not
    # written for -- all refused before their name reaches a URL.
    function Test-Version([string]$v) { $v -match '^[0-9]+\.[0-9]+\.[0-9]+$' }

    if ($version -eq 'latest') {
      # GitHub answers /releases/latest with a redirect to /releases/tag/v<version>;
      # stop at the redirect and read where it points.
      $tag = ''
      try {
        $request = [System.Net.HttpWebRequest]::Create("$releasesUrl/latest")
        $request.AllowAutoRedirect = $false
        $response = $request.GetResponse()
        try { $location = $response.Headers['Location'] } finally { $response.Close() }
        if ($location) { $tag = ($location.TrimEnd('/') -split '/')[-1] }
      } catch {
        $tag = ''
      }
      $version = if ($tag.StartsWith('v')) { $tag.Substring(1) } else { '' }
      if (-not (Test-Version $version)) {
        Fail "could not find the latest release at $releasesUrl/latest"
      }
    }

    if (-not (Test-Version $version)) {
      Fail "`"$version`" is not a release version (expected something like 0.1.40)"
    }

    $zipName = "specdriven-$version-src.zip"
    $target = Join-Path $appDir "specdriven-$version"

    # --- already here? --------------------------------------------------------

    if (Test-Path -LiteralPath $target) {
      # Someone may have run `bun install` or built in there; never throw that
      # away behind their back.
      Say "SpecDriven $version is already unpacked at $target -- not unpacking over it."
      Say '(Delete that directory first to unpack it again.) Building it as it stands.'
    } else {
      # --- download -----------------------------------------------------------

      $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("specdriven-" + [guid]::NewGuid().ToString('N'))
      $scratch.Add($tmpDir)
      New-Item -ItemType Directory -Path $tmpDir | Out-Null
      $base = "$releasesUrl/download/v$version"
      $zipPath = Join-Path $tmpDir $zipName
      $sumsPath = Join-Path $tmpDir 'SHASUMS256.txt'
      $sigPath = Join-Path $tmpDir 'SHASUMS256.txt.sig'

      Say "Downloading SpecDriven $version source..."
      try { Download "$base/$zipName" $zipPath } catch { Fail "failed to download $base/$zipName" }
      try { Download "$base/SHASUMS256.txt" $sumsPath } catch {
        Fail "failed to download $base/SHASUMS256.txt -- refusing to install unverified"
      }
      try { Download "$base/SHASUMS256.txt.sig" $sigPath } catch {
        Fail "failed to download $base/SHASUMS256.txt.sig -- refusing to install unsigned"
      }

      # --- verify -------------------------------------------------------------

      # The signature first: it is what says SHASUMS256.txt came from
      # SpecDriven's release workflow, and so that the checksum in it is worth
      # comparing with.
      $allowedSigners = Join-Path $tmpDir 'allowed_signers'
      [System.IO.File]::WriteAllText($allowedSigners, "$signer $trustedKey`n")
      $verdict = Test-Signature $allowedSigners $sigPath $sumsPath
      if (-not $verdict.ok) {
        Fail ("SHASUMS256.txt is not signed by the SpecDriven release key ($signer) -- refusing to install.`n" +
          "  $($verdict.output)`n" +
          "Either the download was tampered with, or the release was signed with a key this copy of`n" +
          "install.ps1 does not know: the current one is at`n" +
          "https://raw.githubusercontent.com/SpecDriven/specdriven-app/main/install.ps1")
      }
      Say "Signature verified ($signer)."

      # sha256sum's format: the hash, then a space and a space (text mode) or
      # a star (binary mode), then the name.
      $expected = ''
      foreach ($line in Get-Content -LiteralPath $sumsPath) {
        if ($line -match '^([0-9a-fA-F]{64}) [ *](.+)$' -and $Matches[2] -eq $zipName) {
          $expected = $Matches[1].ToLowerInvariant()
          break
        }
      }
      if (-not $expected) { Fail "no checksum listed for $zipName -- refusing to install" }
      $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
      if ($actual -ne $expected) {
        Fail "checksum mismatch for $zipName`n  expected $expected`n  got      $actual"
      }
      Say 'Checksum verified.'

      # --- unpack -------------------------------------------------------------

      New-Item -ItemType Directory -Force -Path $appDir | Out-Null
      # Unpack beside the destination, then rename: one step puts a complete
      # tree in place, so an interrupted install never leaves half a checkout.
      $unpackDir = Join-Path $appDir (".unpack." + [guid]::NewGuid().ToString('N').Substring(0, 8))
      $scratch.Add($unpackDir)
      New-Item -ItemType Directory -Path $unpackDir | Out-Null
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      [System.IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $unpackDir)
      $unpacked = Join-Path $unpackDir "specdriven-$version"
      if (-not (Test-Path -LiteralPath $unpacked -PathType Container)) {
        Fail "unexpected archive layout: no specdriven-$version/ directory inside $zipName"
      }
      [System.IO.Directory]::Move($unpacked, $target)

      # Keep exactly what was verified, for whoever wants to check it themselves.
      Move-Item -Force -LiteralPath $zipPath -Destination (Join-Path $appDir $zipName)
      [System.IO.File]::WriteAllText((Join-Path $appDir "$zipName.sha256"), "$expected  $zipName`n")

      Say "Unpacked to $target"
    }

    # --- point `current` at it ------------------------------------------------

    # A junction on Windows: unlike a symbolic link it needs neither admin
    # rights nor Developer Mode.
    $current = Join-Path $appDir 'current'
    $existing = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
    $previous = ''
    if ($existing -and -not ($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
      Say "warning: $current is not a link; not pointing it at specdriven-$version."
    } else {
      if ($existing -and @($existing.Target).Count -gt 0) {
        $previous = (Split-Path -Leaf ([string]@($existing.Target)[0]).TrimEnd('\', '/')) -replace '^specdriven-', ''
      }
      # Delete() without recursion removes the link alone, never what it points at.
      if ($existing) { $existing.Delete() }
      $linkType = if ($onWindows) { 'Junction' } else { 'SymbolicLink' }
      New-Item -ItemType $linkType -Path $current -Target $target | Out-Null
    }

    # --- keep one version to go back to ---------------------------------------

    # As install.sh: the version `current` pointed at until now stays, to go
    # back to, and every other specdriven-<version> goes with its zip -- only
    # when `current` moved from one version to another, and before the build.
    if ((Test-Version $previous) -and $previous -ne $version) {
      $removed = New-Object System.Collections.Generic.List[string]
      foreach ($entry in @(Get-ChildItem -LiteralPath $appDir -Force -Filter 'specdriven-*')) {
        $old = $entry.Name -replace '^specdriven-', '' -replace '\.sha256$', '' -replace '-src\.zip$', ''
        if (-not (Test-Version $old) -or $old -eq $version -or $old -eq $previous) { continue }
        if ($entry.PSIsContainer -and -not ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
          # .NET's recursive delete removes a junction inside the tree without
          # following it, which Windows PowerShell 5.1's Remove-Item may not.
          [System.IO.Directory]::Delete($entry.FullName, $true)
        } else {
          $entry.Delete()
        }
        if (-not $removed.Contains($old)) { $removed.Add($old) }
      }
      if ($removed.Count -gt 0) {
        Say "Removed older versions: $($removed -join ' ') (kept $previous to go back to)."
      }
    }

    # --- Bun, which builds it -------------------------------------------------

    $bunInstallerUrl = if ($env:SPECDRIVEN_BUN_INSTALLER_URL) { $env:SPECDRIVEN_BUN_INSTALLER_URL } else {
      'https://bun.sh/install.ps1'
    }
    # Bun's own default, spelled out here so the question can name the
    # directory before anything is downloaded. Someone else's BUN_INSTALL wins.
    $bunDir = if ($env:BUN_INSTALL) { $env:BUN_INSTALL } else { Join-Path $HOME '.bun' }
    $bunExe = if ($onWindows) { 'bun.exe' } else { 'bun' }
    $userName = [System.Environment]::UserName

    # Asked only when there is someone to answer. SPECDRIVEN_INSTALL_BUN
    # answers it in advance -- 1/yes installs, 0/no skips -- so an unattended
    # run never hangs on a prompt nobody sees.
    function Test-WantsBun {
      switch -Regex ("$env:SPECDRIVEN_INSTALL_BUN") {
        '^(1|y|yes)$' { return $true }
        '^(0|n|no)$' { return $false }
      }
      # No console to answer at -- a service, redirected input, or a host
      # started with -NonInteractive, where Read-Host would throw.
      $nonInteractive = [Environment]::GetCommandLineArgs() | Where-Object { $_ -match '^-noni' }
      if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected -or $nonInteractive) {
        return $false
      }
      $reply = Read-Host "Bun is needed to build SpecDriven. Install it into $bunDir now, as ${userName}? [y/N]"
      if ($reply -match '^(y|yes)$') { return $true }
      Say 'Leaving Bun alone.'
      return $false
    }

    function Test-Elevated {
      if ($onWindows) {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        return ([Security.Principal.WindowsPrincipal]$identity).IsInRole(
          [Security.Principal.WindowsBuiltInRole]::Administrator)
      }
      return ((& id -u) -eq '0')
    }

    # Runs Bun's own installer as this user: it unpacks into $bunDir and adds
    # that to this user's PATH. Nothing system-wide, nothing elevated.
    function Install-Bun {
      if (Test-Elevated) {
        Say 'Refusing to install Bun from an elevated (Administrator) PowerShell -- run this as the user who will build SpecDriven.'
        return $false
      }
      $bunTmp = Join-Path ([System.IO.Path]::GetTempPath()) ("specdriven-bun-" + [guid]::NewGuid().ToString('N'))
      $scratch.Add($bunTmp)
      New-Item -ItemType Directory -Path $bunTmp | Out-Null
      $installer = Join-Path $bunTmp 'install-bun.ps1'
      # Downloaded, then run: the same script either way, but it lands on disk
      # first, so a failed download cannot be executed as half a script.
      try { Download $bunInstallerUrl $installer } catch {
        Say "Could not download Bun's installer from $bunInstallerUrl."
        return $false
      }
      Say ''
      Say "Installing Bun from $bunInstallerUrl..."
      # In a PowerShell of its own, as Bun's installer expects: it ends with
      # `exit` and sets preferences of its own.
      $shell = (Get-Process -Id $PID).Path
      $previous = $env:BUN_INSTALL
      $env:BUN_INSTALL = $bunDir
      try {
        # To the host, not the pipeline: whatever it prints would otherwise
        # become this function's return value.
        & $shell -NoProfile -ExecutionPolicy Bypass -File $installer | Out-Host
        $ok = ($LASTEXITCODE -eq 0)
      } catch {
        $ok = $false
      } finally {
        $env:BUN_INSTALL = $previous
      }
      return ($ok -and (Test-Path -LiteralPath (Join-Path $bunDir "bin\$bunExe")))
    }

    $bun = $null
    $found = Get-Command bun -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) {
      $bun = $found.Source
      Say ''
      Say "Bun is installed ($bun)."
    } elseif ((Test-WantsBun) -and (Install-Bun)) {
      $bun = Join-Path $bunDir "bin\$bunExe"
      Say ''
      Say "Bun is installed ($bun)."
      Say "Open a new terminal to have $(Join-Path $bunDir 'bin') on PATH; this install uses it either way."
      # `bun run build:desktop` shells out to bun and bunx by name.
      $env:PATH = (Join-Path $bunDir 'bin') + [System.IO.Path]::PathSeparator + $env:PATH
    } else {
      Say 'Bun is not installed; get it from https://bun.sh first.'
    }

    # --- build it -------------------------------------------------------------

    if (-not $bun) {
      Say ''
      Say 'Nothing has been built: Bun is what builds it. Once Bun is there:'
      Say ''
      Say "  cd $current"
      Say '  bun install'
      Say '  bun run start            # web app at http://localhost:3000'
      Say '  bun run build:desktop    # desktop app in release\'
      return
    }

    Push-Location -LiteralPath $target
    try {
      Say ''
      Say 'Installing dependencies...'
      & $bun install --frozen-lockfile
      if ($LASTEXITCODE -ne 0) { Fail "``bun install`` failed in $target" }

      Say ''
      Say 'Building the desktop app -- this fetches Electron and takes a few minutes...'
      # --local: the app unpacked, for this machine's architecture, rather
      # than an installer -- release\win-unpacked\SpecDriven.exe (win-arm64-unpacked
      # on ARM).
      & $bun run build:desktop --local
      if ($LASTEXITCODE -ne 0) { Fail "``bun run build:desktop --local`` failed in $target" }
    } finally {
      Pop-Location
    }

    # --- hand it over ---------------------------------------------------------

    $exe = Get-ChildItem -LiteralPath (Join-Path $target 'release') -Directory -Filter 'win*-unpacked' -ErrorAction SilentlyContinue |
      ForEach-Object { Join-Path $_.FullName 'SpecDriven.exe' } |
      Where-Object { Test-Path -LiteralPath $_ } |
      Select-Object -First 1

    if (-not $exe) {
      Say ''
      Say "SpecDriven $version is built, but there is no SpecDriven.exe under $(Join-Path $target 'release')."
      return
    }

    # Through `current`, so the shortcut follows the next install along.
    $exeDir = Split-Path -Leaf (Split-Path -Parent $exe)
    $viaCurrent = Join-Path $current (Join-Path 'release' (Join-Path $exeDir 'SpecDriven.exe'))
    if ($onWindows) {
      $programs = [Environment]::GetFolderPath('Programs')
      $shortcut = Join-Path $programs 'SpecDriven.lnk'
      try {
        $link = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut)
        $link.TargetPath = $viaCurrent
        $link.WorkingDirectory = Split-Path -Parent $viaCurrent
        $link.Save()
        Say ''
        Say "Added SpecDriven to the Start menu ($shortcut)."
      } catch {
        Say "warning: could not add a Start menu shortcut ($($_.Exception.Message))."
      }
    }

    # SpecDriven keeps its data in git; the app starts without it, but can do
    # little.
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
      Say ''
      Say 'warning: git is not on PATH. SpecDriven keeps its data in git -- install it from https://git-scm.com/download/win.'
    }

    Say ''
    Say "Starting $exe..."
    # Detached, so the app outlives the shell that installed it.
    Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe)

    Say ''
    Say "SpecDriven $version is running."
    Say "The app is in $(Split-Path -Parent $exe); the web app runs from $current with:"
    Say ''
    Say '  bun run start            # http://localhost:3000'
  } catch {
    [Console]::Error.WriteLine('')
    [Console]::Error.WriteLine("error: $($_.Exception.Message)")
    if ($asFile) { exit 1 }
  } finally {
    foreach ($dir in $scratch) {
      if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
    }
  }
}
