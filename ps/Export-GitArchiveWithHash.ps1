# Save this as Export-GitArchiveWithHash.ps1

param (
    [string]$RepoPath = "E:\workspace\video-server",
    [string]$OutputDir = "E:\workspace"
)

# Ensure output directory exists
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir | Out-Null
}

# Generate timestamp for filename
$timestamp = Get-Date -Format "yyyyMMddHHmmss"

# Build output zip path
$zipFile = Join-Path $OutputDir "video-server-$timestamp.zip"

# Step 1: Create archive from Git HEAD
Push-Location $RepoPath
git archive --format=zip -o $zipFile HEAD
Pop-Location

# Step 2: Compute SHA256 hash
$hashResult = Get-FileHash -Path $zipFile -Algorithm SHA256

# Step 3: Display result
$hashResult | Format-Table Algorithm, Hash, Path -AutoSize
