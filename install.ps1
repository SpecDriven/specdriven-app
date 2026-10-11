# SpecDriven installer for Windows -- specs/app/installation.feature.md
# "install on Windows from PowerShell".
#
#   irm https://raw.githubusercontent.com/SpecDriven/specdriven-app-release/main/install.ps1 | iex
#
# The PowerShell twin of install.sh. SpecDriven ships as a source zip so you
# can put the code through your own security checks before building it. This
# script downloads the zip of a release from
# https://github.com/SpecDriven/specdriven-app-release, verifies it against
# that release's SHASUMS256.txt, unpacks it under %USERPROFILE%\.specdriven\app,
# builds the desktop app with Bun, adds it to the Start menu and starts it.
# If Bun is missing it offers to install it, and installs it only if you say
# yes; without Bun it stops after unpacking and says what to run by hand.
#
# To read the code before any of it runs, take the zip from the releases page
# instead and unpack it yourself -- this script is the unattended path.
#
# Environment overrides:
#   SPECDRIVEN_VERSION       release to install, e.g. 0.1.40   (default: latest)
#   SPECDRIVEN_HOME          install prefix                     (default: %USERPROFILE%\.specdriven)
#   SPECDRIVEN_RELEASES_URL  where the releases are             (default: the GitHub releases page)
#   SPECDRIVEN_INSTALL_BUN   answer the Bun question up front   (default: ask; 1 installs, 0 skips)
#   BUN_INSTALL              where Bun would go                 (default: %USERPROFILE%\.bun)
#   SPECDRIVEN_BUN_INSTALLER_URL  Bun's installer               (default: https://bun.sh/install.ps1)
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
      'https://github.com/SpecDriven/specdriven-app-release/releases'
    }
    $releasesUrl = $releasesUrl.TrimEnd('/')
    $prefix = if ($env:SPECDRIVEN_HOME) { $env:SPECDRIVEN_HOME } else { Join-Path $HOME '.specdriven' }
    $appDir = Join-Path $prefix 'app'
    $version = if ($env:SPECDRIVEN_VERSION) { $env:SPECDRIVEN_VERSION } else { 'latest' }
    if ($version.StartsWith('v')) { $version = $version.Substring(1) }

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

      Say "Downloading SpecDriven $version source..."
      try { Download "$base/$zipName" $zipPath } catch { Fail "failed to download $base/$zipName" }
      try { Download "$base/SHASUMS256.txt" $sumsPath } catch {
        Fail "failed to download $base/SHASUMS256.txt -- refusing to install unverified"
      }

      # --- verify -------------------------------------------------------------

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
    if ($existing -and -not ($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
      Say "warning: $current is not a link; not pointing it at specdriven-$version."
    } else {
      # Delete() without recursion removes the link alone, never what it points at.
      if ($existing) { $existing.Delete() }
      $linkType = if ($onWindows) { 'Junction' } else { 'SymbolicLink' }
      New-Item -ItemType $linkType -Path $current -Target $target | Out-Null
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
      & $bun install
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
