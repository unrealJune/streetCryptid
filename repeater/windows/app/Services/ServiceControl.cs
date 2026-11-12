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
