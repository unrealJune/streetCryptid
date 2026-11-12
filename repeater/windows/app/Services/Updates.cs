using System.Runtime.InteropServices;
using Velopack;

namespace StreetCryptid.Repeater.Services;

public sealed class Updates
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly UpdateManager manager = new(
        "https://github.com/unrealJune/streetCryptid/releases/download/repeater-preview",
        new UpdateOptions
        {
            ExplicitChannel = RuntimeInformation.ProcessArchitecture == Architecture.Arm64
                ? "repeater-win-arm64" : "repeater-win-x64"
        });

    public bool CanRestart => manager.IsInstalled && manager.UpdatePendingRestart is not null;

    public async Task<string> CheckAsync()
    {
        if (!manager.IsInstalled) return "Install a prerelease to enable updates.";
        if (!await gate.WaitAsync(0)) return "Checking for updates.";
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(5));
            var available = await manager.CheckForUpdatesAsync().WaitAsync(TimeSpan.FromSeconds(30));
            if (available is null) return CanRestart ? "Update ready. Restart to apply." : "Up to date.";
            await manager.DownloadUpdatesAsync(available, cancelToken: timeout.Token);
            return "Update ready. Restart to apply.";
        }
        catch { return "Update check failed. Try again."; }
        finally { gate.Release(); }
    }

    public void Restart() => manager.ApplyUpdatesAndRestart(manager.UpdatePendingRestart);
}
