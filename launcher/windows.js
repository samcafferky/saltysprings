'use strict';

const { execFile, spawn } = require('node:child_process');

const isWindows = process.platform === 'win32';

// Runs a PowerShell script. Values go in through environment variables so
// paths with spaces or quotes can't break the script.
function powershell(script, env = {}) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(`[Console]::OutputEncoding = [Text.Encoding]::UTF8\n${script}`, 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-EncodedCommand', encoded],
      { env: { ...process.env, ...env }, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout.trim())),
    );
  });
}

// Opens the normal Windows "choose a folder" window. Resolves '' if cancelled.
function pickFolder() {
  if (!isWindows) return Promise.reject(new Error('The folder picker only works on Windows. Paste the path instead.'));
  return powershell(`
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Select your Fortnite build folder'
$dialog.ShowNewFolderButton = $false
if ($env:OGFN_START) { $dialog.SelectedPath = $env:OGFN_START }
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }
$owner.Dispose()
`);
}

// Starts a program paused (it never runs any code). Returns its process id.
const START_SUSPENDED = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OgfnProcess {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize;
    public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags;
    public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
    public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);
  public static int StartSuspended(string exe, string args, string dir) {
    STARTUPINFO si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    PROCESS_INFORMATION pi;
    const uint CREATE_SUSPENDED = 0x4;
    if (!CreateProcess(exe, "\\"" + exe + "\\" " + args, IntPtr.Zero, IntPtr.Zero, false, CREATE_SUSPENDED, IntPtr.Zero, dir, ref si, out pi))
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return pi.dwProcessId;
  }
}
'@
[Console]::Out.Write([OgfnProcess]::StartSuspended($env:OGFN_EXE, $env:OGFN_ARGS, $env:OGFN_DIR))
`;

async function startSuspended(exe, args, cwd) {
  const out = await powershell(START_SUSPENDED, { OGFN_EXE: exe, OGFN_ARGS: args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '), OGFN_DIR: cwd });
  const pid = Number(out);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Could not start ${exe}`);
  return pid;
}

function startGame(exe, args, cwd) {
  return spawn(exe, args, { cwd, stdio: 'ignore', windowsHide: false });
}

function kill(pid) {
  try {
    process.kill(pid);
  } catch {
    // Already closed.
  }
}

function openBrowser(url) {
  const [cmd, args] = isWindows ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref();
  } catch {
    // The URL is printed in the terminal anyway.
  }
}

module.exports = { isWindows, pickFolder, startSuspended, startGame, kill, openBrowser };
