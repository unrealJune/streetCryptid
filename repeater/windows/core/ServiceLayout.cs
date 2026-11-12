using System.Text;

namespace StreetCryptid.Repeater.Core;

/// <summary>
/// Where each half of the repeater lives. Per user, the app and its host run from the Velopack
/// install under the person's profile and keep the node in their local app data. As a Windows
/// service the host must not run from anywhere the person can write — the service account would
/// then run whatever they put there — so the service and the host are copied under Program Files,
/// and the node's state lives under ProgramData, readable only by the service and administrators.
/// </summary>
public static class ServiceLayout
{
    public const string ServiceName = "StreetCryptidRepeater";
    public const string DisplayName = "streetCryptid repeater";
    public const string Description =
        "Carries encrypted streetCryptid location updates for the people who enrolled, " +
        "so friends' phones can fetch them while the sender's phone is asleep.";
    public const string Account = @"NT SERVICE\" + ServiceName;
    public const string PipeName = "streetcryptid-repeater";
    public const string ServiceExecutable = "StreetCryptid.Repeater.Service.exe";
    public const string HostExecutable = "streetcryptid-repeater-host.exe";

    /// <summary>Files the service needs beside it; the licence notices travel with the binaries.</summary>
    public static readonly string[] InstalledFiles =
        [ServiceExecutable, HostExecutable, "NOTICE", "LICENSE"];

    /// <summary>Must match the Rust host's <c>SERVICE_MARKER</c>.</summary>
    public const string MovedMarker = "moved-to-service";

    public static string UserStateDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "streetCryptid", "Repeater");

    public static string ServiceStateDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "streetCryptid", "Repeater");

    public static string InstallDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "streetCryptid Repeater");

    /// <summary>Quote one argument the way CommandLineToArgvW reads it back.</summary>
    public static string Quote(string argument)
    {
        if (argument.Length > 0 && argument.IndexOfAny([' ', '\t', '\n', '\v', '"']) < 0) return argument;
        var quoted = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char c in argument)
        {
            if (c == '\\') { backslashes++; continue; }
            if (c == '"') quoted.Append('\\', backslashes * 2 + 1);
            else quoted.Append('\\', backslashes);
            backslashes = 0;
            quoted.Append(c);
        }
        quoted.Append('\\', backslashes * 2).Append('"');
        return quoted.ToString();
    }

    public static string CommandLine(IEnumerable<string> arguments) => string.Join(' ', arguments.Select(Quote));
}

/// <summary>Exit codes of the elevated service verbs, which is all the app sees of them.</summary>
public enum ServiceVerbResult
{
    Ok = 0,
    Failed = 1,
    /// <summary>Both places hold a different identity; moving either would destroy one.</summary>
    IdentityConflict = 2,
    BadArguments = 3,
    /// <summary>The service did not stop, so its files could not be moved or replaced.</summary>
    StillRunning = 4,
}

/// <summary>
/// Moving a repeater's node state between the per-user directory and the service's. The identity
/// must exist in exactly one place at a time: two hosts answering for one endpoint id is the
/// failure mode the phones' NodeHost exists to prevent, and a lost key means claiming a new
/// repeater. So a move copies everything into a staging directory beside the destination, swaps
/// it into place, and only then deletes the source — an interrupted move leaves a complete copy at
/// the source and is finished by running it again.
/// </summary>
public static class StateMigration
{
    public const string IdentityFile = "secret.key";

    /// <summary>The app's own preferences and transient files stay where they are.</summary>
    private static readonly string[] NotNodeState = ["settings.json", "host.lock", MovedMarkerName];
    private const string MovedMarkerName = ServiceLayout.MovedMarker;

    public static bool IsNodeState(string name) =>
        !NotNodeState.Contains(name, StringComparer.OrdinalIgnoreCase) &&
        !name.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase);

    public static bool HasIdentity(string directory) => File.Exists(Path.Combine(directory, IdentityFile));

    /// <summary>Move node state from <paramref name="source"/> into <paramref name="destination"/>.</summary>
    public static ServiceVerbResult Move(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        string staging = destination.TrimEnd(Path.DirectorySeparatorChar) + ".incoming";
        // A staging directory holding a key is a complete copy whose swap was interrupted.
        if (Directory.Exists(staging) && HasIdentity(staging))
        {
            if (HasIdentity(source) && !SameIdentity(source, staging)) return ServiceVerbResult.IdentityConflict;
            if (HasIdentity(destination)) return ServiceVerbResult.IdentityConflict;
            Swap(staging, destination);
            if (HasIdentity(source)) DeleteNodeState(source);
            return ServiceVerbResult.Ok;
        }
        if (!HasIdentity(source)) return ServiceVerbResult.Ok;
        if (HasIdentity(destination))
        {
            // A finished move whose source was not yet deleted: same identity, finish it.
            if (!SameIdentity(source, destination)) return ServiceVerbResult.IdentityConflict;
            DeleteNodeState(source);
            return ServiceVerbResult.Ok;
        }
        if (Directory.EnumerateFileSystemEntries(destination).Any(path => IsNodeState(Path.GetFileName(path))))
            return ServiceVerbResult.IdentityConflict;
        if (Directory.Exists(staging)) Directory.Delete(staging, true);
        Directory.CreateDirectory(staging);
        foreach (string entry in Directory.EnumerateFileSystemEntries(source))
        {
            string name = Path.GetFileName(entry);
            if (!IsNodeState(name) || name.Equals(IdentityFile, StringComparison.OrdinalIgnoreCase)) continue;
            if (Directory.Exists(entry)) CopyDirectory(entry, Path.Combine(staging, name));
            else File.Copy(entry, Path.Combine(staging, name));
        }
        // The key last, so a staging directory with a key in it is always complete.
        File.Copy(Path.Combine(source, IdentityFile), Path.Combine(staging, IdentityFile));
        Swap(staging, destination);
        DeleteNodeState(source);
        return ServiceVerbResult.Ok;
    }

    private static bool SameIdentity(string a, string b) =>
        File.ReadAllBytes(Path.Combine(a, IdentityFile)).AsSpan()
            .SequenceEqual(File.ReadAllBytes(Path.Combine(b, IdentityFile)));

    /// <summary>Move a complete staging copy into place, the key last, then drop the staging directory.</summary>
    private static void Swap(string staging, string destination)
    {
        foreach (string entry in Directory.EnumerateFileSystemEntries(staging))
        {
            string name = Path.GetFileName(entry);
            if (name.Equals(IdentityFile, StringComparison.OrdinalIgnoreCase)) continue;
            string target = Path.Combine(destination, name);
            if (Directory.Exists(entry)) Directory.Move(entry, target);
            else File.Move(entry, target);
        }
        File.Move(Path.Combine(staging, IdentityFile), Path.Combine(destination, IdentityFile));
        Directory.Delete(staging, true);
    }

    private static void DeleteNodeState(string directory)
    {
        // Everything but the key first: a directory left with only a key is still a valid
        // (if empty) repeater, never a keyless one with a roster.
        foreach (string entry in Directory.EnumerateFileSystemEntries(directory))
        {
            string name = Path.GetFileName(entry);
            if (!IsNodeState(name) || name.Equals(IdentityFile, StringComparison.OrdinalIgnoreCase)) continue;
            if (Directory.Exists(entry)) Directory.Delete(entry, true);
            else File.Delete(entry);
        }
        File.Delete(Path.Combine(directory, IdentityFile));
    }

    private static void CopyDirectory(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (string file in Directory.EnumerateFiles(source))
            File.Copy(file, Path.Combine(destination, Path.GetFileName(file)));
        foreach (string directory in Directory.EnumerateDirectories(source))
            CopyDirectory(directory, Path.Combine(destination, Path.GetFileName(directory)));
    }
}
