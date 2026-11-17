using System.Reflection;
using System.Security.AccessControl;
using System.Security.Principal;
using StreetCryptid.Repeater.Core;

namespace StreetCryptid.Repeater.Service;

/// <summary>
/// <c>run --owner SID</c> is what the SCM starts. <c>install</c> and <c>uninstall</c> are run
/// elevated by the desktop app; their exit code (<see cref="ServiceVerbResult"/>) is all it sees.
/// <c>update</c> is the unattended updater's service (<see cref="Updater"/>), started by the app
/// with the version to install; its exit code comes back through the SCM.
/// </summary>
public static class Program
{
    public static string Version { get; } = typeof(Program).Assembly
        .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion.Split('+')[0]
        ?? "0.0.0";

    public static int Main(string[] args)
    {
        try
        {
            return args switch
            {
                ["run", "--owner", var owner] => Run(new SecurityIdentifier(owner)),
                ["install", "--owner", var owner, "--from", var from] when Path.IsPathFullyQualified(from) =>
                    (int)Installer.Install(new SecurityIdentifier(owner), from),
                ["uninstall", "--to", var to] when Path.IsPathFullyQualified(to) =>
                    (int)Installer.Uninstall(to),
                ["update"] => ServiceDispatcher.Run(Updater.RunAsync) ? 0 : (int)ServiceVerbResult.BadArguments,
                _ => (int)ServiceVerbResult.BadArguments,
            };
        }
        catch (ArgumentException) { return (int)ServiceVerbResult.BadArguments; }
        catch (Exception) { return (int)ServiceVerbResult.Failed; }
    }

    private static int Run(SecurityIdentifier owner)
    {
        bool dispatched = ServiceDispatcher.Run(async (_, stop) =>
        {
            var hub = new Hub(Version);
            var supervisor = new Supervisor(
                Path.Combine(AppContext.BaseDirectory, ServiceLayout.HostExecutable),
                ServiceLayout.ServiceStateDirectory, hub);
            var pipe = new PipeServer(owner, hub, supervisor);
            var host = supervisor.RunAsync(stop);
            var clients = pipe.RunAsync(stop);
            // If the pipe cannot be served (someone else holds its name) the service fails and
            // the SCM's recovery restarts it, rather than running a repeater nobody can see.
            await Task.WhenAny(host, clients);
            if (clients.IsFaulted) await clients;
            await Task.WhenAll(host, clients);
            return 0u;
        });
        return dispatched ? 0 : (int)ServiceVerbResult.BadArguments;
    }
}

/// <summary>The elevated half: put the service in place, or take it away, moving the identity with it.</summary>
internal static class Installer
{
    private static readonly TimeSpan StopTimeout = TimeSpan.FromSeconds(30);

    public static ServiceVerbResult Install(SecurityIdentifier owner, string from)
    {
        // An updater mid-run would be replacing the same files.
        if (!Scm.Stop(StopTimeout, ServiceLayout.UpdaterName)) return ServiceVerbResult.StillRunning;
        if (!Scm.Stop(StopTimeout)) return ServiceVerbResult.StillRunning;
        string install = ServiceLayout.InstallDirectory;
        Directory.CreateDirectory(install);
        DeleteReplaced();
        foreach (string name in ServiceLayout.InstalledFiles)
        {
            string source = Path.Combine(AppContext.BaseDirectory, name);
            if (!File.Exists(source))
            {
                if (name is ServiceLayout.ServiceExecutable or ServiceLayout.HostExecutable)
                    return ServiceVerbResult.Failed;
                continue;
            }
            string target = Path.Combine(install, name);
            string staged = target + ".new";
            File.Copy(source, staged, true);
            File.Move(staged, target, true);
        }
        string commandLine = ServiceLayout.CommandLine(
            [Path.Combine(install, ServiceLayout.ServiceExecutable), "run", "--owner", owner.Value]);
        Scm.Install(commandLine);
        Scm.InstallUpdater(ServiceLayout.CommandLine(
            [Path.Combine(install, ServiceLayout.ServiceExecutable), "update"]), owner.Value);

        var service = (SecurityIdentifier)new NTAccount(ServiceLayout.Account).Translate(typeof(SecurityIdentifier));
        string state = ServiceLayout.ServiceStateDirectory;
        SecureServiceRoot(Path.GetDirectoryName(state)!, service);
        Directory.CreateDirectory(from);
        var moved = StateMigration.Move(from, state);
        if (moved != ServiceVerbResult.Ok) return moved;
        // The per-user host refuses a directory whose identity went to the service.
        File.WriteAllText(Path.Combine(from, ServiceLayout.MovedMarker),
            "This repeater's identity now belongs to the streetCryptid repeater Windows service.\r\n");
        Scm.Start();
        return ServiceVerbResult.Ok;
    }

    public static ServiceVerbResult Uninstall(string to)
    {
        if (!Scm.Stop(StopTimeout, ServiceLayout.UpdaterName)) return ServiceVerbResult.StillRunning;
        if (!Scm.Stop(StopTimeout)) return ServiceVerbResult.StillRunning;
        string state = ServiceLayout.ServiceStateDirectory;
        if (Directory.Exists(state))
        {
            Directory.CreateDirectory(to);
            var moved = StateMigration.Move(state, to);
            if (moved != ServiceVerbResult.Ok) return moved;
        }
        File.Delete(Path.Combine(to, ServiceLayout.MovedMarker));
        Scm.Delete(ServiceLayout.UpdaterName);
        Scm.Delete();
        // The SCM releases the executable shortly after deletion; a leftover copy is harmless.
        for (int attempt = 0; attempt < 20 && Directory.Exists(ServiceLayout.InstallDirectory); attempt++)
        {
            try { Directory.Delete(ServiceLayout.InstallDirectory, true); }
            catch (Exception) when (attempt < 19) { Thread.Sleep(500); }
            catch (Exception) { }
        }
        try { if (Directory.Exists(state)) Directory.Delete(state, true); }
        catch (Exception) { }
        return ServiceVerbResult.Ok;
    }

    /// <summary>
    /// Put the service's files from <paramref name="source"/> in place of the installed ones, with
    /// the service stopped, and start it again; if it will not start, put the old files back. A
    /// file that is running (the updater's own executable) cannot be overwritten but can be
    /// renamed, so every replaced file is renamed aside first and deleted on a later run.
    /// </summary>
    public static ServiceVerbResult Replace(string source)
    {
        string install = ServiceLayout.InstallDirectory;
        foreach (string name in new[] { ServiceLayout.ServiceExecutable, ServiceLayout.HostExecutable })
            if (!File.Exists(Path.Combine(source, name))) return ServiceVerbResult.Failed;
        DeleteReplaced();
        if (!Scm.Stop(StopTimeout)) return ServiceVerbResult.StillRunning;
        var replaced = new List<(string Target, string? Aside)>();
        try
        {
            foreach (string name in ServiceLayout.InstalledFiles)
            {
                string from = Path.Combine(source, name);
                if (!File.Exists(from)) continue;
                string target = Path.Combine(install, name);
                string staged = target + ".new";
                // A copy, not a move: the copy takes the install directory's permissions.
                File.Copy(from, staged, true);
                string? aside = null;
                if (File.Exists(target))
                {
                    aside = $"{target}.{Guid.NewGuid():N}{ReplacedSuffix}";
                    File.Move(target, aside);
                }
                replaced.Add((target, aside));
                File.Move(staged, target);
            }
            Scm.Start();
            return ServiceVerbResult.Ok;
        }
        catch (Exception)
        {
            Scm.Stop(StopTimeout);
            foreach (var (target, aside) in Enumerable.Reverse(replaced))
            {
                try
                {
                    if (aside is not null) File.Move(aside, target, true);
                    else File.Delete(target);
                }
                catch (Exception) { }
            }
            try { Scm.Start(); } catch (Exception) { }
            return ServiceVerbResult.Failed;
        }
        finally
        {
            foreach (string name in ServiceLayout.InstalledFiles)
                try { File.Delete(Path.Combine(install, name) + ".new"); } catch (Exception) { }
        }
    }

    private const string ReplacedSuffix = ".replaced";

    /// <summary>Files an earlier update renamed aside; one still running is left for next time.</summary>
    private static void DeleteReplaced()
    {
        if (!Directory.Exists(ServiceLayout.InstallDirectory)) return;
        foreach (string file in Directory.EnumerateFiles(ServiceLayout.InstallDirectory, "*" + ReplacedSuffix))
            try { File.Delete(file); } catch (Exception) { }
    }

    /// <summary>
    /// ProgramData lets every user create folders, so one could exist before we do — owned by
    /// whoever made it. Take ownership and replace its DACL: SYSTEM, Administrators and the
    /// service, nobody else, inherited by everything beneath.
    /// </summary>
    private static void SecureServiceRoot(string root, SecurityIdentifier service)
    {
        var directory = Directory.CreateDirectory(root);
        var administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        var security = new DirectorySecurity();
        security.SetOwner(administrators);
        security.SetAccessRuleProtection(true, false);
        const InheritanceFlags inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        foreach (var sid in new[]
                 {
                     new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), administrators, service,
                 })
            security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, inherit,
                PropagationFlags.None, AccessControlType.Allow));
        directory.SetAccessControl(security);
    }
}
