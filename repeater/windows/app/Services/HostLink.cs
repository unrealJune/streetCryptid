using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using StreetCryptid.Repeater.Core;

namespace StreetCryptid.Repeater.Services;

/// <summary>
/// The app's connection to the host, whichever way it runs. Both speak the same line protocol:
/// per user over the host's own stdin/stdout, as a service over the service's pipe (which adds
/// <c>service</c> messages and survives the host restarting under it).
/// </summary>
public abstract class HostLink : IAsyncDisposable
{
    private static readonly TimeSpan StartupDeadline = TimeSpan.FromSeconds(40);
    private static readonly TimeSpan SnapshotDeadline = TimeSpan.FromSeconds(30);
    protected readonly CancellationTokenSource Cancellation = new();
    private readonly ArrivalTracker arrivals = new();
    private readonly ConcurrentDictionary<string, TaskCompletionSource<bool>> commands = new();
    private readonly SemaphoreSlim inputLock = new(1, 1);
    private string? runId;
    protected bool Stopping;
    private bool disposed;

    public event Action<HostSnapshot>? Snapshot;
    public event Action? Arrival;
    public event Action<ServiceStatus>? Service;
    /// <summary>The message, and whether the other side speaks an incompatible protocol.</summary>
    public event Action<string, bool>? Failed;

    public abstract void Start();
    protected abstract Task WriteLineAsync(string line, CancellationToken token);
    protected abstract Task CloseAsync();
    protected virtual string StoppedMessage => "Repeater stopped. Retry.";

    protected void Fail(string message, bool incompatible = false) => Failed?.Invoke(message, incompatible);

    protected async Task PumpAsync(TextReader reader, Action onLost)
    {
        var token = Cancellation.Token;
        try
        {
            using var watchdog = CancellationTokenSource.CreateLinkedTokenSource(token);
            watchdog.CancelAfter(StartupDeadline);
            await foreach (string line in HostProtocol.ReadLines(reader, watchdog.Token))
            {
                HostMessage message;
                try { message = HostProtocol.Parse(line); }
                catch (InvalidDataException) when (runId is null)
                {
                    Fail("The repeater service is from another version of this app. Update it to continue.", true);
                    onLost();
                    return;
                }
                if (message.Service is { } status)
                {
                    // A host that is (re)starting under the service owes no snapshot until it is up.
                    if (status.Host == "running") watchdog.CancelAfter(StartupDeadline);
                    else watchdog.CancelAfter(Timeout.InfiniteTimeSpan);
                    Service?.Invoke(status);
                    continue;
                }
                if (runId != message.RunId)
                {
                    // Only the service restarts a host under a live connection.
                    if (runId is not null && this is not ServiceLink)
                        throw new InvalidDataException("Host identity changed.");
                    runId = message.RunId;
                    arrivals.Reset();
                }
                if (message.Snapshot is { } snapshot)
                {
                    watchdog.CancelAfter(SnapshotDeadline);
                    if (arrivals.Observe(snapshot.Received, true)) Arrival?.Invoke();
                    Snapshot?.Invoke(snapshot);
                }
                else if (message.Kind == "result")
                {
                    if (commands.TryRemove(message.RequestId!, out var completion))
                        completion.TrySetResult(message.Ok);
                }
                else if (arrivals.Observe(message.Sequence, false)) Arrival?.Invoke();
            }
            if (!Stopping) Fail(StoppedMessage);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch
        {
            if (!Stopping) Fail("Repeater connection lost. Retry.");
            onLost();
        }
        finally
        {
            foreach (var completion in commands.Values) completion.TrySetResult(false);
            commands.Clear();
        }
    }

    public Task<bool> ApplySettingsAsync(HostSettings settings)
    {
        string id = Guid.NewGuid().ToString("N");
        return SendCommandAsync(id, HostProtocol.SettingsCommand(id, settings));
    }

    /// <summary>Release this repeater from its roster; true once the host confirms.</summary>
    public Task<bool> ReleaseAsync()
    {
        string id = Guid.NewGuid().ToString("N");
        return SendCommandAsync(id, HostProtocol.ReleaseCommand(id));
    }

    private async Task<bool> SendCommandAsync(string id, string command)
    {
        var completion = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        commands[id] = completion;
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(Cancellation.Token);
            timeout.CancelAfter(TimeSpan.FromSeconds(15));
            await inputLock.WaitAsync(timeout.Token);
            try
            {
                if (Stopping) return false;
                await WriteLineAsync(command, timeout.Token);
            }
            finally { inputLock.Release(); }
            return await completion.Task.WaitAsync(timeout.Token);
        }
        catch { return false; }
        finally { commands.TryRemove(id, out _); }
    }

    public async ValueTask DisposeAsync()
    {
        if (disposed) return;
        disposed = true;
        Stopping = true;
        try { await CloseAsync(); } catch { }
        Cancellation.Cancel();
        Cancellation.Dispose();
        GC.SuppressFinalize(this);
    }
}

/// <summary>The host as this app's own child: it lives exactly as long as the app does.</summary>
public sealed class ChildLink(string directory) : HostLink
{
    private Process? process;
    private NativeLifetime? lifetime;
    private Task? pump;

    public override void Start()
    {
        if (process is not null) return;
        try
        {
            var start = new ProcessStartInfo(Path.Combine(AppContext.BaseDirectory, ServiceLayout.HostExecutable))
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            start.ArgumentList.Add("--state-dir");
            start.ArgumentList.Add(directory);
            start.ArgumentList.Add("--mode");
            start.ArgumentList.Add("user");
            process = Process.Start(start) ?? throw new IOException("Host did not start.");
            lifetime = new NativeLifetime(process.Handle);
            // Stderr is deliberately not logged: a dependency may include peer or ticket details.
            _ = process.StandardError.BaseStream.CopyToAsync(Stream.Null, CancellationToken.None);
            var child = process;
            pump = PumpAsync(child.StandardOutput, () => TryKill(child));
        }
        catch
        {
            if (process is not null) TryKill(process);
            Fail("Repeater could not start. Retry.");
        }
    }

    protected override async Task WriteLineAsync(string line, CancellationToken token)
    {
        if (process is null) throw new InvalidOperationException();
        await process.StandardInput.WriteLineAsync(line.AsMemory(), token);
        await process.StandardInput.FlushAsync(token);
    }

    protected override async Task CloseAsync()
    {
        if (process is { } child)
        {
            try
            {
                child.StandardInput.Close();
                await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(6));
            }
            catch { TryKill(child); }
        }
        if (pump is not null)
        {
            try { await pump.WaitAsync(TimeSpan.FromSeconds(2)); }
            catch (Exception) { }
        }
        process?.Dispose();
        lifetime?.Dispose();
    }

    private static void TryKill(Process child)
    {
        try { if (!child.HasExited) child.Kill(true); }
        catch (InvalidOperationException) { }
        catch (System.ComponentModel.Win32Exception) { }
    }
}

/// <summary>
/// The host under the Windows service, over its pipe. Before trusting anything on the pipe the
/// app checks that the process serving it IS the service: a pipe name can be squatted by anyone
/// on the machine, and the first thing the real one sends is a claim code.
/// </summary>
public sealed class ServiceLink : HostLink
{
    private NamedPipeClientStream? pipe;
    private Task? pump;

    protected override string StoppedMessage => "The repeater service stopped. Retry.";

    public override void Start()
    {
        if (pipe is not null) return;
        _ = ConnectAsync();
    }

    private async Task ConnectAsync()
    {
        try
        {
            pipe = new NamedPipeClientStream(".", ServiceLayout.PipeName, PipeDirection.InOut,
                PipeOptions.Asynchronous, TokenImpersonationLevel.Identification);
            await pipe.ConnectAsync(TimeSpan.FromSeconds(10), Cancellation.Token);
            if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out uint server) ||
                Scm.Query() is not { State: Scm.Running } service || service.ProcessId != server)
            {
                await pipe.DisposeAsync();
                Fail("Something other than the repeater service answered. Restart Windows and retry.");
                return;
            }
            var connected = pipe;
            pump = PumpAsync(new StreamReader(connected, new System.Text.UTF8Encoding(false)), () => connected.Dispose());
        }
        catch (OperationCanceledException) when (Stopping) { }
        catch (UnauthorizedAccessException)
        {
            Fail("This Windows account cannot open the repeater service. Sign in as the account that set it up.");
        }
        catch
        {
            if (!Stopping) Fail("The repeater service is not answering. Retry.");
        }
    }

    protected override async Task WriteLineAsync(string line, CancellationToken token)
    {
        if (pipe is not { IsConnected: true } connected) throw new InvalidOperationException();
        await connected.WriteAsync(System.Text.Encoding.UTF8.GetBytes(line + "\n"), token);
        await connected.FlushAsync(token);
    }

    protected override async Task CloseAsync()
    {
        if (pipe is not null) await pipe.DisposeAsync();
        if (pump is not null)
        {
            try { await pump.WaitAsync(TimeSpan.FromSeconds(2)); }
            catch (Exception) { }
        }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeServerProcessId(Microsoft.Win32.SafeHandles.SafePipeHandle pipe,
        out uint processId);
}
