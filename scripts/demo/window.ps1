# Window control for the demo recording (Windows).
#   -Action minimize-all             minimize every top-level window (Win+D style)
#   -Action restore-all              undo minimize-all
#   -Action front -Match <text>      maximize and bring to the front the window of the Code process
#                                    whose command line contains <text> (the recording's user-data dir)
#   -Action taskbar                  print "<physical taskbar height>" of the primary screen
param([string]$Action, [string]$Match = '')
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Win {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
}
'@
switch ($Action) {
  'minimize-all' { (New-Object -ComObject Shell.Application).MinimizeAll() }
  'restore-all' { (New-Object -ComObject Shell.Application).UndoMinimizeAll() }
  'taskbar' {
    [void][Win]::SetProcessDPIAware()
    Add-Type -AssemblyName System.Windows.Forms
    $s = [System.Windows.Forms.Screen]::PrimaryScreen
    $s.Bounds.Height - $s.WorkingArea.Height
  }
  'front' {
    $ids = Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Where-Object { $_.CommandLine -like "*$Match*" } | ForEach-Object { $_.ProcessId }
    $win = Get-Process -Id $ids -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if (-not $win) { 'no window'; exit 1 }
    $h = $win.MainWindowHandle
    if (-not [Win]::IsZoomed($h)) { [Win]::ShowWindow($h, 3) | Out-Null }  # SW_MAXIMIZE
    if ([Win]::GetForegroundWindow() -eq $h) { 'already in front'; exit 0 }
    # A lone Alt press lets this process move the foreground; only when needed, since inside
    # VS Code it would focus the menu bar.
    [Win]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
    [Win]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [Win]::BringWindowToTop($h) | Out-Null
    [Win]::SetForegroundWindow($h) | Out-Null
    'moved to front'
  }
}
