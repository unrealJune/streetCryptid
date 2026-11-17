using System.ComponentModel;
using System.Diagnostics;
using System.Reflection;
using System.Security.Principal;
using StreetCryptid.Repeater.Core;

namespace StreetCryptid.Repeater.Services;

/// <summary>
/// Putting the repeater under the Windows service and taking it back out. Both need an
/// administrator, so both run this app's copy of the service executable elevated; Windows shows
/// the consent prompt, and the exit code is all that comes back.
/// </summary>
public static class ServiceControl
{
    public static string AppVersion { get; } = typeof(ServiceControl).Assembly
        .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion.Split('+')[0] ?? "0.0.0";

    public static bool IsInstalled()
    {
        try { return Scm.IsInstalled(); }
        catch (Win32Exception) { return false; }
    }

    /// <summary>Install, or update the installed copy to this version. Null when the prompt was declined.</summary>
    public static Task<ServiceVerbResult?> InstallAsync(string userDirectory) =>
        RunElevatedAsync(["install", "--owner", CurrentUser(), "--from", userDirectory], TimeSpan.FromMinutes(2));

    /// <summary>Whether the installed service has the unattended updater (installs before it did not).</summary>
    public static bool HasUpdater()
    {
        try { return Scm.IsInstalled(ServiceLayout.UpdaterName); }
        catch (Win32Exception) { return false; }
    }

    /// <summary>
    /// Bring the service up to <see cref="AppVersion"/> with no prompt, through the updater the
    /// install registered (service/Updater.cs), and wait for its verdict. Null when there is no
    /// updater this person may start — a service installed before it existed — so the caller can
    /// fall back to <see cref="InstallAsync"/>.
    /// </summary>
    public static async Task<ServiceVerbResult?> UpdateUnattendedAsync(TimeSpan timeout)
    {
        try
        {
            if (!Scm.IsInstalled(ServiceLayout.UpdaterName)) return null;
            // Already running means someone else asked first; its verdict is ours too.
            Scm.StartWith(ServiceLayout.UpdaterName, AppVersion);
            var deadline = DateTime.UtcNow + timeout;
            while (DateTime.UtcNow < deadline)
            {
                await Task.Delay(TimeSpan.FromSeconds(1));
                if (Scm.QueryFull(ServiceLayout.UpdaterName) is not { } status) return null;
                if (status.State != Scm.Stopped) continue;
                return Enum.IsDefined(typeof(ServiceVerbResult), (int)status.ExitCode)
                    ? (ServiceVerbResult)(int)status.ExitCode
                    : ServiceVerbResult.Failed;
            }
            return ServiceVerbResult.Failed;
        }
        catch (Win32Exception) { return null; }
    }

    public static Task<ServiceVerbResult?> UninstallAsync(string userDirectory, TimeSpan? timeout = null) =>
        RunElevatedAsync(["uninstall", "--to", userDirectory], timeout ?? TimeSpan.FromMinutes(2));

    public static string Describe(ServiceVerbResult? result) => result switch
    {
        null => "Administrator approval was declined. Nothing changed.",
        ServiceVerbResult.Ok => "Done.",
        ServiceVerbResult.IdentityConflict =>
            "Both this account and the service hold a different repeater identity. Nothing was moved; " +
            "keep the one your phone claimed and remove the other by hand.",
        ServiceVerbResult.StillRunning => "The repeater service did not stop in time. Try again.",
        ServiceVerbResult.BadArguments => "The repeater service rejected the request.",
        ServiceVerbResult.NotNewer => "The repeater service is already this version or newer.",
        ServiceVerbResult.DownloadFailed => "The update for the repeater service could not be downloaded. Try again.",
        _ => "The repeater service could not be changed. Try again.",
    };

    private static string CurrentUser()
    {
        using var identity = WindowsIdentity.GetCurrent();
        return identity.User!.Value;
    }

    private static async Task<ServiceVerbResult?> RunElevatedAsync(string[] arguments, TimeSpan timeout)
    {
        var start = new ProcessStartInfo(Path.Combine(AppContext.BaseDirectory, ServiceLayout.ServiceExecutable))
        {
            UseShellExecute = true,
            Verb = "runas",
            Arguments = ServiceLayout.CommandLine(arguments),
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        Process? process;
        try { process = Process.Start(start); }
        catch (Win32Exception error) when (error.NativeErrorCode == 1223) { return null; }
        if (process is null) return ServiceVerbResult.Failed;
        using (process)
        {
            try { await process.WaitForExitAsync().WaitAsync(timeout); }
            catch (TimeoutException) { return ServiceVerbResult.Failed; }
            return Enum.IsDefined(typeof(ServiceVerbResult), process.ExitCode)
                ? (ServiceVerbResult)process.ExitCode
                : ServiceVerbResult.Failed;
        }
    }
}
