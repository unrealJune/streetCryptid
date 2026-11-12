using System.Diagnostics;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using StreetCryptid.Repeater.Core;

namespace StreetCryptid.Repeater.Service;

/// <summary>
/// Fans the host's lines out to every connected app. A newcomer is first told what the service
/// is and then given the latest snapshot, so it never waits two seconds for a first screen.
/// </summary>
internal sealed class Hub(string version)
{
    private readonly object gate = new();
    private readonly HashSet<Channel<string>> clients = [];
    private string? snapshot;
    private string status = Status(version, "starting", 0);

    public Channel<string> Join()
    {
        var channel = Channel.CreateBounded<string>(new BoundedChannelOptions(256) { SingleReader = true });
        lock (gate)
        {
            channel.Writer.TryWrite(status);
            if (snapshot is not null) channel.Writer.TryWrite(snapshot);
            clients.Add(channel);
        }
        return channel;
    }

    public void Leave(Channel<string> channel)
    {
        lock (gate) clients.Remove(channel);
        channel.Writer.TryComplete();
    }

    public void SetHost(string host, int restarts)
    {
        string line = Status(version, host, restarts);
        lock (gate)
        {
            status = line;
            if (host != "running") snapshot = null;
        }
        Broadcast(line);
    }

    public void Publish(string line, bool isSnapshot)
    {
        if (isSnapshot) lock (gate) snapshot = line;
        Broadcast(line);
    }

    private void Broadcast(string line)
    {
        List<Channel<string>> slow = [];
        lock (gate)
            foreach (var client in clients)
                if (!client.Writer.TryWrite(line)) slow.Add(client);
        // An app that stopped reading is disconnected rather than allowed to hold memory; it
        // reconnects and is handed the latest snapshot.
        foreach (var client in slow) Leave(client);
    }

    private static string Status(string version, string host, int restarts)
    {
        using var buffer = new MemoryStream();
        using (var json = new Utf8JsonWriter(buffer))
        {
            json.WriteStartObject();
            json.WriteNumber("protocol", HostProtocol.Version);
            json.WriteString("kind", "service");
            json.WriteStartObject("service");
            json.WriteString("version", version);
            json.WriteString("host", host);
            json.WriteNumber("restarts", restarts);
            json.WriteEndObject();
            json.WriteEndObject();
        }
        return Encoding.UTF8.GetString(buffer.ToArray());
    }
}

/// <summary>
/// Runs the Rust host for as long as the service runs, restarting it with backoff when it exits.
/// The host is bound to this process by a kill-on-close job and stops on stdin EOF, exactly as it
/// does under the desktop app.
/// </summary>
internal sealed class Supervisor(string hostPath, string stateDirectory, Hub hub)
{
    private static readonly TimeSpan MaxBackoff = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan HealthyRun = TimeSpan.FromMinutes(10);
    private readonly SemaphoreSlim inputLock = new(1, 1);
    private Process? process;

    public async Task RunAsync(CancellationToken stop)
    {
        int restarts = 0;
        int failures = 0;
        while (!stop.IsCancellationRequested)
        {
            hub.SetHost(restarts == 0 ? "starting" : "restarting", restarts);
            var started = Stopwatch.StartNew();
            try { await RunOnceAsync(restarts, stop); }
            catch (Exception) when (!stop.IsCancellationRequested) { }
            if (stop.IsCancellationRequested) break;
            restarts++;
            failures = started.Elapsed > HealthyRun ? 1 : failures + 1;
            hub.SetHost("restarting", restarts);
            var delay = TimeSpan.FromSeconds(Math.Min(MaxBackoff.TotalSeconds, 2 * Math.Pow(3, failures - 1)));
            try { await Task.Delay(delay, stop); }
            catch (OperationCanceledException) { break; }
        }
        hub.SetHost("stopped", restarts);
    }

    private async Task RunOnceAsync(int restarts, CancellationToken stop)
    {
        var start = new ProcessStartInfo(hostPath)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.ArgumentList.Add("--state-dir");
        start.ArgumentList.Add(stateDirectory);
        start.ArgumentList.Add("--mode");
        start.ArgumentList.Add("service");
        using var child = Process.Start(start) ?? throw new IOException("Host did not start.");
        using var lifetime = new NativeLifetime(child.Handle);
        process = child;
        // Stderr is deliberately not kept: a dependency may include peer or ticket details.
        _ = child.StandardError.BaseStream.CopyToAsync(Stream.Null, CancellationToken.None);
        using var stopping = stop.Register(() =>
        {
            try { child.StandardInput.Close(); } catch (Exception) { }
        });
        bool running = false;
        try
        {
            await foreach (string line in HostProtocol.ReadLines(child.StandardOutput, CancellationToken.None))
            {
                bool isSnapshot = KindOf(line) == "snapshot";
                if (isSnapshot && !running)
                {
                    running = true;
                    hub.SetHost("running", restarts);
                }
                hub.Publish(line, isSnapshot);
            }
        }
        finally
        {
            process = null;
            if (!child.WaitForExit(10_000))
            {
                try { child.Kill(true); } catch (Exception) { }
            }
        }
    }

    /// <summary>Forward one validated command; false when there is no host to take it.</summary>
    public async Task<bool> SendAsync(string line, CancellationToken cancellation)
    {
        await inputLock.WaitAsync(cancellation);
        try
        {
            if (process is not { HasExited: false } child) return false;
            await child.StandardInput.WriteLineAsync(line.AsMemory(), cancellation);
            await child.StandardInput.FlushAsync(cancellation);
            return true;
        }
        catch (IOException) { return false; }
        catch (InvalidOperationException) { return false; }
        finally { inputLock.Release(); }
    }

    private static string? KindOf(string line)
    {
        try
        {
            using var document = JsonDocument.Parse(line);
            return document.RootElement.TryGetProperty("kind", out var kind) ? kind.GetString() : null;
        }
        catch (JsonException) { return null; }
    }
}

/// <summary>
/// The pipe the desktop app connects to. Only the person who installed the service may open it —
/// the claim code travels over it — and it refuses remote clients. The first instance is created
/// with FILE_FLAG_FIRST_PIPE_INSTANCE so a pipe someone else squatted on fails the service rather
/// than being served beside.
/// </summary>
internal sealed class PipeServer(SecurityIdentifier owner, Hub hub, Supervisor supervisor)
{
    private const int MaxClients = 8;
    private const int MaxCommandLength = 4096;

    public async Task RunAsync(CancellationToken stop)
    {
        var security = new PipeSecurity();
        security.SetAccessRuleProtection(true, false);
        using var self = WindowsIdentity.GetCurrent();
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl,
            AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(self.User!, PipeAccessRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(owner,
            PipeAccessRights.ReadWrite | PipeAccessRights.Synchronize, AccessControlType.Allow));
        bool first = true;
        while (!stop.IsCancellationRequested)
        {
            var options = PipeOptions.Asynchronous | (first ? PipeOptions.FirstPipeInstance : PipeOptions.None);
            var server = NamedPipeServerStreamAcl.Create(ServiceLayout.PipeName, PipeDirection.InOut, MaxClients,
                PipeTransmissionMode.Byte, options, 0, 0, security);
            first = false;
            try { await server.WaitForConnectionAsync(stop); }
            catch (OperationCanceledException)
            {
                await server.DisposeAsync();
                break;
            }
            _ = ServeAsync(server, stop);
        }
    }

    private async Task ServeAsync(NamedPipeServerStream pipe, CancellationToken stop)
    {
        var channel = hub.Join();
        using var session = CancellationTokenSource.CreateLinkedTokenSource(stop);
        var writer = Task.Run(async () =>
        {
            var utf8 = new UTF8Encoding(false);
            await foreach (string line in channel.Reader.ReadAllAsync(session.Token))
            {
                await pipe.WriteAsync(utf8.GetBytes(line + "\n"), session.Token);
                await pipe.FlushAsync(session.Token);
            }
        });
        try
        {
            using var reader = new StreamReader(pipe, new UTF8Encoding(false), false, 4096, leaveOpen: true);
            while (!session.IsCancellationRequested)
            {
                string? line = await ReadBoundedLineAsync(reader, session.Token);
                if (line is null || !HostProtocol.IsSettingsCommand(line)) break;
                if (!await supervisor.SendAsync(line, session.Token)) break;
            }
        }
        catch (Exception) { }
        finally
        {
            hub.Leave(channel);
            session.Cancel();
            try { await writer; } catch (Exception) { }
            await pipe.DisposeAsync();
        }
    }

    private static async Task<string?> ReadBoundedLineAsync(StreamReader reader, CancellationToken cancellation)
    {
        var line = new StringBuilder();
        var one = new char[1];
        while (await reader.ReadAsync(one.AsMemory(), cancellation) == 1)
        {
            if (one[0] == '\n') return line.ToString().TrimEnd('\r');
            if (line.Length >= MaxCommandLength) return null;
            line.Append(one[0]);
        }
        return null;
    }
}
