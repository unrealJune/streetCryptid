using System.Runtime.InteropServices;

namespace StreetCryptid.Repeater.Services;

public sealed class TrayIcon : IDisposable
{
    private const uint CallbackMessage = 0x8001;
    private readonly IntPtr window;
    private readonly SubclassProc callback;
    private readonly uint taskbarCreated = RegisterWindowMessageW("TaskbarCreated");
    private readonly IntPtr icon;
    private bool disposed;
    public event Action? Open;
    public event Action? Settings;
    public event Action? Update;
    public event Action? Quit;
    public event Action<bool>? SessionLocked;

    public TrayIcon(IntPtr window)
    {
        this.window = window;
        callback = WindowMessage;
        icon = LoadMark(window);
        if (!SetWindowSubclass(window, callback, 1, UIntPtr.Zero))
            throw new System.ComponentModel.Win32Exception();
        WTSRegisterSessionNotification(window, 0);
        Add();
    }

    private void Add()
    {
        var data = Data();
        if (!Shell_NotifyIconW(0, ref data))
            throw new System.ComponentModel.Win32Exception();
    }

    private NotifyIconData Data() => new()
    {
        Size = (uint)Marshal.SizeOf<NotifyIconData>(), Window = window, Id = 1,
        Flags = 1 | 2 | 4, Callback = CallbackMessage, Icon = icon,
        Tip = "streetCryptid repeater", Info = "", InfoTitle = ""
    };

    private IntPtr WindowMessage(IntPtr hwnd, uint message, UIntPtr wparam, IntPtr lparam,
        UIntPtr id, UIntPtr data)
    {
        try
        {
            if (message == taskbarCreated) Add();
            if (message == 0x02B1)
            {
                if (wparam.ToUInt64() == 7) SessionLocked?.Invoke(true);
                if (wparam.ToUInt64() == 8) SessionLocked?.Invoke(false);
            }
            if (message == CallbackMessage)
            {
                uint action = (uint)lparam.ToInt64() & 0xFFFF;
                if (action == 0x0202 || action == 0x0203 || action == 0x0401) Open?.Invoke();
                if (action == 0x0205 || action == 0x007B) ShowMenu();
            }
        }
        catch { /* Never let an exception unwind through a native window callback. */ }
        return DefSubclassProc(hwnd, message, wparam, lparam);
    }

    private void ShowMenu()
    {
        IntPtr menu = CreatePopupMenu();
        try
        {
            AppendMenuW(menu, 0, 1, "Open");
            AppendMenuW(menu, 0, 2, "Settings");
            AppendMenuW(menu, 0, 3, "Check for updates");
            AppendMenuW(menu, 0x800, 0, null);
            AppendMenuW(menu, 0, 4, "Quit");
            GetCursorPos(out var point);
            SetForegroundWindow(window);
            uint result = TrackPopupMenu(menu, 0x100 | 0x2, point.X, point.Y, 0, window, IntPtr.Zero);
            switch (result)
            {
                case 1: Open?.Invoke(); break;
                case 2: Settings?.Invoke(); break;
                case 3: Update?.Invoke(); break;
                case 4: Quit?.Invoke(); break;
            }
            PostMessageW(window, 0, UIntPtr.Zero, IntPtr.Zero);
        }
        finally { DestroyMenu(menu); }
    }

    /// <summary>The app icon at the notification area's size for this window's DPI.</summary>
    private static IntPtr LoadMark(IntPtr window)
    {
        uint dpi = GetDpiForWindow(window);
        int size = GetSystemMetricsForDpi(49 /* SM_CXSMICON */, dpi == 0 ? 96 : dpi);
        IntPtr loaded = LoadImageW(IntPtr.Zero, Path.Combine(AppContext.BaseDirectory, "Assets", "repeater.ico"),
            1 /* IMAGE_ICON */, size, size, 0x10 /* LR_LOADFROMFILE */);
        if (loaded == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
        return loaded;
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        var data = Data();
        Shell_NotifyIconW(2, ref data);
        RemoveWindowSubclass(window, callback, 1);
        WTSUnRegisterSessionNotification(window);
        DestroyIcon(icon);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NotifyIconData
    {
        public uint Size;
        public IntPtr Window;
        public uint Id, Flags, Callback;
        public IntPtr Icon;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Tip;
        public uint State, StateMask;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string Info;
        public uint Timeout;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string InfoTitle;
        public uint InfoFlags;
        public Guid GuidItem;
        public IntPtr BalloonIcon;
    }
    [StructLayout(LayoutKind.Sequential)] private struct Point { public int X, Y; }
    private delegate IntPtr SubclassProc(IntPtr hwnd, uint message, UIntPtr wparam, IntPtr lparam, UIntPtr id, UIntPtr data);
    [DllImport("comctl32.dll")] private static extern bool SetWindowSubclass(IntPtr hwnd, SubclassProc callback, UIntPtr id, UIntPtr data);
    [DllImport("comctl32.dll")] private static extern bool RemoveWindowSubclass(IntPtr hwnd, SubclassProc callback, UIntPtr id);
    [DllImport("comctl32.dll")] private static extern IntPtr DefSubclassProc(IntPtr hwnd, uint message, UIntPtr wparam, IntPtr lparam);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] private static extern bool Shell_NotifyIconW(uint action, ref NotifyIconData data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern uint RegisterWindowMessageW(string message);
    [DllImport("user32.dll")] private static extern IntPtr CreatePopupMenu();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool AppendMenuW(IntPtr menu, uint flags, UIntPtr id, string? text);
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern uint TrackPopupMenu(IntPtr menu, uint flags, int x, int y, int reserved, IntPtr hwnd, IntPtr rect);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool PostMessageW(IntPtr hwnd, uint message, UIntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll")] private static extern bool DestroyMenu(IntPtr menu);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr LoadImageW(IntPtr instance, string name, uint type, int cx, int cy, uint flags);
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern int GetSystemMetricsForDpi(int index, uint dpi);
    [DllImport("user32.dll")] private static extern bool DestroyIcon(IntPtr icon);
    [DllImport("wtsapi32.dll")] private static extern bool WTSRegisterSessionNotification(IntPtr hwnd, uint flags);
    [DllImport("wtsapi32.dll")] private static extern bool WTSUnRegisterSessionNotification(IntPtr hwnd);
}
