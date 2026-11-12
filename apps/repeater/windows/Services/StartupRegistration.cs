using Microsoft.Win32;
using Velopack.Locators;

namespace StreetCryptid.Repeater.Services;

public static class StartupRegistration
{
    private const string Name = "streetCryptid Repeater";
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

    public static bool IsRegistered()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKey);
        return key?.GetValue(Name) is string;
    }

    public static bool IsDisabledByWindows()
    {
        using var key = Registry.CurrentUser.OpenSubKey(
            @"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run");
        return key?.GetValue(Name) is byte[] { Length: > 0 } bytes && bytes[0] == 3;
    }

    public static void Apply(bool enabled, Action save)
    {
        string? command = null;
        if (enabled)
        {
            string? root = VelopackLocator.Current.RootAppDir;
            string launcher = string.IsNullOrEmpty(root)
                ? Environment.ProcessPath ?? Path.Combine(AppContext.BaseDirectory, "StreetCryptid.Repeater.exe")
                : Path.Combine(root, "current", "StreetCryptid.Repeater.exe");
            if (!File.Exists(launcher)) throw new InvalidOperationException("Repeater executable not found.");
            command = $"\"{launcher}\" --startup";
        }
        using var current = Registry.CurrentUser.OpenSubKey(RunKey);
        object? previous = current?.GetValue(Name);
        if (Equals(previous, command)) { save(); return; }
        var kind = previous is null ? RegistryValueKind.String : current!.GetValueKind(Name);
        using var key = Registry.CurrentUser.CreateSubKey(RunKey);
        if (command is null) key.DeleteValue(Name, false);
        else key.SetValue(Name, command, RegistryValueKind.String);
        try { save(); }
        catch
        {
            if (previous is null) key.DeleteValue(Name, false);
            else key.SetValue(Name, previous, kind);
            throw;
        }
    }
}
