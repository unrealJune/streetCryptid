using System.Runtime.InteropServices;
using Velopack;

namespace StreetCryptid.Repeater.Services;

public enum UpdateCheck { Unavailable, Busy, UpToDate, Ready, Failed }

/// <summary>
/// The app's half of an update. The service's half (its copy under Program Files) is finished by
/// the app that restarts with <see cref="FinishArgument"/>, so a person sees one update.
/// </summary>
public sealed class Updates
{
    /// <summary>Passed to the updated app, which then brings the service up to its own version.</summary>
    public const string FinishArgument = "--finish-update";

    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly UpdateManager manager = new(
        "https://github.com/unrealJune/streetCryptid/releases/download/repeater-preview",
        new UpdateOptions
        {
            ExplicitChannel = RuntimeInformation.ProcessArchitecture == Architecture.Arm64
                ? "repeater-win-arm64" : "repeater-win-x64"
        });

    public bool IsInstalled => manager.IsInstalled;
    public bool CanRestart => manager.IsInstalled && manager.UpdatePendingRestart is not null;

    public async Task<UpdateCheck> CheckAsync()
    {
        if (!manager.IsInstalled) return UpdateCheck.Unavailable;
        if (!await gate.WaitAsync(0)) return UpdateCheck.Busy;
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(5));
            var available = await manager.CheckForUpdatesAsync().WaitAsync(TimeSpan.FromSeconds(30));
            if (available is null) return CanRestart ? UpdateCheck.Ready : UpdateCheck.UpToDate;
            await manager.DownloadUpdatesAsync(available, cancelToken: timeout.Token);
            return UpdateCheck.Ready;
        }
        catch { return UpdateCheck.Failed; }
        finally { gate.Release(); }
    }

    public void Restart() =>
        manager.ApplyUpdatesAndRestart(manager.UpdatePendingRestart, [FinishArgument]);
}
