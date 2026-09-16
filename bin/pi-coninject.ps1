<#
  pi-coninject.ps1 — 把一段文本当作键盘输入写进「本进程继承到的那个控制台」的输入缓冲区。

  用途：pi 冷重启时，pi 无法重启自己的父进程（shell），所以由 pi-relaunch.mjs 通过本脚本，
        把 `pi --session <id>` 注入原控制台的输入缓冲区，让停在提示符处的 shell 自己
        「敲出」这条命令并回车执行 —— 于是新 pi 由原 shell 拉起，终端/窗口/标签页都不变，
        不新开窗口（真·原终端接管）。

  关键点：
    · 不依赖窗口焦点（不是 SendKeys），只写控制台输入缓冲区。
    · 两条取句柄的路径：
        1) 继承来的 fd0：pi 进程的 stdin 就是它所在控制台的 CONIN$，由 pi-self-update 扩展
           以 stdio:["inherit", ...] 一路继承下来（跨控制台句柄可写）。用 GetConsoleMode 验证。
        2) -TargetPid：句柄无效/被重定向时，AttachConsole 到目标进程所在控制台，再开 CONIN$。
    · 两条都失败 → 非 0 退出码，调用方（pi-relaunch.mjs）据此降级为新窗口拉起。

  ⚠️ 本文件必须存为 UTF-8 with BOM：Windows PowerShell 5.1 无 BOM 时按 ANSI 解码，
     中文注释的字节会被误解码，串进 Add-Type 的 C# 源码里会让编译失败（已踩过）。
     C# 部分注释一律用 ASCII，双保险。

  参数:
    -Text <string>     要注入的文本（脚本自动补 CR 回车）
    -TextFile <path>   从文件读文本（避免命令行转义问题）
    -TargetPid <int>   [备用/测试] 挂到该进程所在控制台再注入

  退出码: 0 成功 / 2 attach 失败 / 3 无控制台输入句柄 / 4 写入失败 / 5 CONIN$ 打开失败
#>
param(
  [string]$Text = $env:PI_INJECT_TEXT,
  [string]$TextFile = '',
  [int]$TargetPid = 0
)
$ErrorActionPreference = 'Stop'
if ($TextFile -ne '') { $Text = [System.IO.File]::ReadAllText($TextFile) }

Add-Type -Namespace PiInject -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Explicit)]
public struct INPUT_RECORD {
  [System.Runtime.InteropServices.FieldOffset(0)] public ushort EventType;
  [System.Runtime.InteropServices.FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent;
}
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Explicit, CharSet=System.Runtime.InteropServices.CharSet.Unicode)]
public struct KEY_EVENT_RECORD {
  [System.Runtime.InteropServices.FieldOffset(0)] public int bKeyDown;
  [System.Runtime.InteropServices.FieldOffset(4)] public ushort wRepeatCount;
  [System.Runtime.InteropServices.FieldOffset(6)] public ushort wVirtualKeyCode;
  [System.Runtime.InteropServices.FieldOffset(8)] public ushort wVirtualScanCode;
  [System.Runtime.InteropServices.FieldOffset(10)] public char UnicodeChar;
  [System.Runtime.InteropServices.FieldOffset(12)] public uint dwControlKeyState;
}
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint dwProcessId);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] public static extern System.IntPtr GetStdHandle(int nStdHandle);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetConsoleMode(System.IntPtr h, out uint mode);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true, CharSet=System.Runtime.InteropServices.CharSet.Unicode, EntryPoint="CreateFileW")]
public static extern System.IntPtr CreateFile(string name, uint access, uint share, System.IntPtr sec, uint disp, uint flags, System.IntPtr tmpl);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true, CharSet=System.Runtime.InteropServices.CharSet.Unicode, EntryPoint="WriteConsoleInputW")]
public static extern bool WriteConsoleInput(System.IntPtr hConsoleInput, INPUT_RECORD[] lpBuffer, uint nLength, out uint lpNumberOfEventsWritten);

// wVirtualKeyCode is always 0 (only Enter gets VK_RETURN): characters are carried
// purely by UnicodeChar. Do NOT use the char's ASCII code as its VK -- e.g. '-' (0x2D)
// would be read as VK_INSERT and swallowed.
static INPUT_RECORD Make(char c, bool down) {
  INPUT_RECORD r = new INPUT_RECORD();
  r.EventType = 1; // KEY_EVENT
  r.KeyEvent.bKeyDown = down ? 1 : 0;
  r.KeyEvent.wRepeatCount = 1;
  r.KeyEvent.wVirtualKeyCode = (c == '\r' || c == '\n') ? (ushort)0x0D : (ushort)0;
  r.KeyEvent.wVirtualScanCode = 0;
  r.KeyEvent.UnicodeChar = (c == '\n') ? '\r' : c;
  r.KeyEvent.dwControlKeyState = 0;
  return r;
}
public static int Send(IntPtr h, string text) {
  System.Collections.Generic.List<INPUT_RECORD> list = new System.Collections.Generic.List<INPUT_RECORD>();
  foreach (char c in text) { list.Add(Make(c, true)); list.Add(Make(c, false)); }
  uint written;
  bool ok = WriteConsoleInput(h, list.ToArray(), (uint)list.Count, out written);
  if (!ok) return -1;
  return (int)written;
}
'@

# 1) 首选：fd0 就是继承下来的原控制台输入句柄（pi → cmd/start → 重启器 → 本脚本）
$h = [PiInject.Native]::GetStdHandle(-10)
$src = 'inherited'
$mode = 0
if ($h -eq [System.IntPtr]::Zero -or $h -eq [System.IntPtr]::new(-1) -or -not [PiInject.Native]::GetConsoleMode($h, [ref]$mode)) {
  # 句柄无效、或不是控制台（如被重定向）→ 换 2) 按 pid 挂到目标控制台
  $h = [System.IntPtr]::Zero
  if ($TargetPid -gt 0) {
    [void][PiInject.Native]::FreeConsole()
    if (-not [PiInject.Native]::AttachConsole([uint32]$TargetPid)) {
      $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
      Write-Output "FAIL attach pid=$TargetPid err=$err"
      exit 2
    }
    # AttachConsole 不会改写已存在的 std 句柄 → 显式开 CONIN$
    $h = [PiInject.Native]::CreateFile('CONIN$', 3221225472, 3, [System.IntPtr]::Zero, 3, 0, [System.IntPtr]::Zero)
    if ($h -eq [System.IntPtr]::Zero -or $h -eq [System.IntPtr]::new(-1)) {
      $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
      Write-Output "FAIL conin err=$err"
      exit 5
    }
    $src = "attached:$TargetPid"
  }
}

if ($h -eq [System.IntPtr]::Zero -or $h -eq [System.IntPtr]::new(-1)) {
  Write-Output 'FAIL no-console-input-handle'
  exit 3
}

$payload = $Text
if (-not $payload.EndsWith("`r")) { $payload += "`r" }
$n = [PiInject.Native]::Send($h, $payload)
if ($n -lt 0) {
  $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  Write-Output "FAIL write err=$err"
  exit 4
}
Write-Output "OK events=$n source=$src"
exit 0
