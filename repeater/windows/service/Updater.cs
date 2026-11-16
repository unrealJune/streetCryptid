using System.IO.Compression;
using System.Runtime.InteropServices;
using StreetCryptid.Repeater.Core;

namespace StreetCryptid.Repeater.Service;

/// <summary>
/// The unattended service update, run as LocalSystem by the SCM when the owner's app starts the
/// updater service with the version it just updated to. Without it, every app update ended with an
/// administrator prompt for the service's copy under Program Files.
///
/// What it trusts: HTTPS to this project's GitHub releases, the same source the app's own update
/// comes from. What a caller controls: only which version, and it must be newer than this one, so
/// the worst a caller can do is install a release we published early. It never reads anything
/// from a directory the person can write. Once releases are signed, the downloaded executables
/// should also be checked against the installed copy's publisher here.
/// </summary>
internal static class Updater
{
    private const long MaxArchiveBytes = 256L * 1024 * 1024;
    private static readonly TimeSpan DownloadTimeout = TimeSpan.FromMinutes(10);

    public static async Task<uint> RunAsync(string[] arguments, CancellationToken stop)
    {
        if (arguments is not [var requested] || !ReleaseVersion.TryParse(requested, out var target) ||
            !ReleaseVersion.TryParse(Program.Version, out var installed))
            return (uint)ServiceVerbResult.BadArguments;
        if (target.CompareTo(installed) <= 0) return (uint)ServiceVerbResult.NotNewer;

        string rid = RuntimeInformation.ProcessArchitecture == Architecture.Arm64 ? "win-arm64" : "win-x64";
        string staging = ServiceLayout.UpdateStagingDirectory;
        try
        {
            if (Directory.Exists(staging)) Directory.Delete(staging, true);
            Directory.CreateDirectory(staging);
            string archive = Path.Combine(staging, ServiceLayout.ServiceArchive(rid));
            try { await DownloadAsync(new Uri(ServiceLayout.ServiceArchiveUrl(target, rid)), archive, stop); }
            catch (Exception) when (!stop.IsCancellationRequested) { return (uint)ServiceVerbResult.DownloadFailed; }
            string unpacked = Path.Combine(staging, "files");
            if (!Unpack(archive, unpacked)) return (uint)ServiceVerbResult.Failed;
            stop.ThrowIfCancellationRequested();
            return (uint)Installer.Replace(unpacked);
        }
        finally
        {
            try { if (Directory.Exists(staging)) Directory.Delete(staging, true); }
            catch (Exception) { }
        }
    }

    private static async Task DownloadAsync(Uri uri, string path, CancellationToken stop)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(stop);
        timeout.CancelAfter(DownloadTimeout);
        using var client = new HttpClient(new SocketsHttpHandler
        {
            // GitHub answers a release download with a redirect to its storage host; never to plain HTTP.
            AllowAutoRedirect = true,
            MaxAutomaticRedirections = 5,
        });
        client.DefaultRequestHeaders.UserAgent.ParseAdd($"streetCryptid-repeater-updater/{Program.Version}");
        using var response = await client.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
        response.EnsureSuccessStatusCode();
        if (response.RequestMessage?.RequestUri?.Scheme != Uri.UriSchemeHttps)
            throw new HttpRequestException("Redirected away from HTTPS.");
        if (response.Content.Headers.ContentLength > MaxArchiveBytes)
            throw new HttpRequestException("Release archive too large.");
        await using var body = await response.Content.ReadAsStreamAsync(timeout.Token);
        await using var file = File.Create(path);
        var buffer = new byte[81920];
        long total = 0;
        int read;
        while ((read = await body.ReadAsync(buffer, timeout.Token)) > 0)
        {
            total += read;
            if (total > MaxArchiveBytes) throw new HttpRequestException("Release archive too large.");
            await file.WriteAsync(buffer.AsMemory(0, read), timeout.Token);
        }
    }

    /// <summary>
    /// Only the service's own files, by name, from the archive's root; anything else in it is
    /// ignored, and an archive without the service and the host is refused.
    /// </summary>
    private static bool Unpack(string archive, string destination)
    {
        try
        {
            Directory.CreateDirectory(destination);
            using var zip = ZipFile.OpenRead(archive);
            foreach (string name in ServiceLayout.InstalledFiles)
            {
                var entry = zip.Entries.FirstOrDefault(e => e.FullName == name);
                if (entry is null || entry.Length > MaxArchiveBytes) continue;
                entry.ExtractToFile(Path.Combine(destination, name), false);
            }
            return File.Exists(Path.Combine(destination, ServiceLayout.ServiceExecutable)) &&
                   File.Exists(Path.Combine(destination, ServiceLayout.HostExecutable));
        }
        catch (Exception) { return false; }
    }
}
