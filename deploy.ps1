<#
.SYNOPSIS
    Copies the Frosted Harmony website from this PC to the Linux server and restarts it.

.EXAMPLE
    .\deploy.ps1 -Server derek@192.168.1.50

.NOTES
    Your .env file on the server is never overwritten.
    Requires SSH access to the server (see docs\SETUP-GUIDE.md, Part 4).
#>
[CmdletBinding()]
param(
    # Linux user name and server address, for example derek@192.168.1.50
    [Parameter(Mandatory = $true)]
    [string]$Server,

    # Folder in the Linux user's home directory.
    [string]$RemoteDir = 'frostedharmony'
)

$ErrorActionPreference = 'Stop'
$archive = Join-Path $env:TEMP 'frostedharmony-deploy.tgz'
if (Test-Path $archive) { Remove-Item $archive }

Write-Host '1/3 Packaging website files...' -ForegroundColor Cyan
tar.exe --exclude=node_modules -czf $archive -C $PSScriptRoot docker-compose.yml .env.example nginx site api
if ($LASTEXITCODE -ne 0) { throw 'Packaging failed.' }

Write-Host "2/3 Copying to $Server ..." -ForegroundColor Cyan
scp $archive "${Server}:/tmp/frostedharmony-deploy.tgz"
if ($LASTEXITCODE -ne 0) { throw 'Copy failed. Check the server address and that SSH works: ssh ' + $Server }

Write-Host '3/3 Unpacking and starting containers on the server...' -ForegroundColor Cyan
$remote = "set -e; mkdir -p '$RemoteDir'; tar --warning=no-unknown-keyword -xzf /tmp/frostedharmony-deploy.tgz -C '$RemoteDir'; rm -f /tmp/frostedharmony-deploy.tgz; cd '$RemoteDir'; if [ ! -f .env ]; then echo 'Files copied. No .env file yet: follow guide Part 11 to create it, then run: docker compose up -d --build'; exit 0; fi; docker compose up -d --build; docker compose exec -T web nginx -s reload; docker compose ps"
ssh $Server $remote
if ($LASTEXITCODE -ne 0) { throw 'The server reported an error. Read the messages above.' }

Remove-Item $archive -ErrorAction SilentlyContinue
Write-Host 'Done.' -ForegroundColor Green
