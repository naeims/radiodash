# Run the Server in WSL at Windows Startup

This guide starts the RadioDash server inside WSL when Windows starts. PM2 runs
inside WSL and manages the Node process.

The server runs from:

```bash
/home/naeim/dev/radiodash/server
```

The extension expects the server at:

```text
http://localhost:5000
```

## 1. Install PM2 in WSL

Open a WSL shell and install PM2 globally:

```bash
npm install -g pm2
pm2 --version
```

If Node is installed through `nvm`, set the current Node version as the default:

```bash
nvm alias default v26.1.0
```

If you change Node versions later, update the default alias and restart the PM2
process.

## 2. Start the Server with PM2

From WSL:

```bash
cd /home/naeim/dev/radiodash/server
npm ci
pm2 start npm --name radiodash-server -- start
pm2 save
pm2 status
```

Verify the server:

```bash
curl http://localhost:5000/templates
```

That should return a JSON list of templates.

Common PM2 commands:

```bash
pm2 status
pm2 logs radiodash-server
pm2 restart radiodash-server
pm2 stop radiodash-server
pm2 delete radiodash-server
pm2 save
```

Run `pm2 save` after changing the process list. The Windows startup task uses
PM2's saved process list when it resurrects the server.

## 3. Create the WSL Startup Script

Create a script that loads `nvm`, selects the default Node version, and restores
the saved PM2 processes.

```bash
mkdir -p /home/naeim/bin
nano /home/naeim/bin/radiodash-pm2-resurrect.sh
```

Paste this into the file:

```bash
#!/usr/bin/env bash
set -euo pipefail

export NVM_DIR="$HOME/.nvm"

if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  nvm use --silent default >/dev/null
fi

pm2 resurrect
```

Make it executable:

```bash
chmod +x /home/naeim/bin/radiodash-pm2-resurrect.sh
```

Test it:

```bash
pm2 kill
/home/naeim/bin/radiodash-pm2-resurrect.sh
pm2 status
curl http://localhost:5000/templates
```

## 4. Create the Windows Scheduled Task

Open PowerShell on Windows, not inside WSL.

List WSL distributions:

```powershell
wsl -l -v
```

If RadioDash is in the default WSL distribution, create the task with:

```powershell
$Action = New-ScheduledTaskAction `
  -Execute "$env:WINDIR\System32\wsl.exe" `
  -Argument "-u naeim -- /home/naeim/bin/radiodash-pm2-resurrect.sh"

$Trigger = New-ScheduledTaskTrigger -AtLogOn

$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable

Register-ScheduledTask `
  -TaskName "RadioDash WSL PM2" `
  -Action $Action `
  -Trigger $Trigger `
  -Settings $Settings `
  -Description "Start RadioDash server under PM2 in WSL at Windows logon" `
  -Force
```

If RadioDash is not in the default WSL distribution, include the distro name in
the action argument. Replace `Ubuntu-26.04` with the name shown by `wsl -l -v`.

```powershell
$Action = New-ScheduledTaskAction `
  -Execute "$env:WINDIR\System32\wsl.exe" `
  -Argument "-d Ubuntu-26.04 -u naeim -- /home/naeim/bin/radiodash-pm2-resurrect.sh"
```

Then run the same `$Trigger`, `$Settings`, and `Register-ScheduledTask` commands
shown above.

## 5. Test the Startup Task

From PowerShell:

```powershell
wsl --shutdown
Start-ScheduledTask -TaskName "RadioDash WSL PM2"
Start-Sleep -Seconds 5
curl.exe http://localhost:5000/templates
```

If `curl.exe` returns the template list, Windows startup is configured.

## Troubleshooting

Check PM2 from WSL:

```bash
pm2 status
pm2 logs radiodash-server
```

Check the saved PM2 process list:

```bash
pm2 resurrect
```

If `pm2` or `node` is not found when Windows starts the task, confirm the startup
script can load `nvm`:

```bash
/home/naeim/bin/radiodash-pm2-resurrect.sh
```

If the server starts but the extension cannot connect, verify the extension and
server are using the same URL:

```text
http://localhost:5000
```

