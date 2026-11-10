using System.Text;
using System.Text.Json;

namespace StreetCryptid.Repeater.Core;

/// <summary>Choices the host keeps for this machine (see the Rust host's <c>HostSettings</c>).</summary>
public sealed record HostSettings(bool Telemetry, bool KeepAwake);

public sealed record HostSnapshot(
    string EndpointId, bool Claimed, string? ClaimUrl, string? Owner,
    string? Policy, string[] Members, ulong Tracked, ulong Missing, ulong Received,
    ulong Connections = 0, ulong ConnectionsOpened = 0,
    ulong BytesReceived = 0, ulong BytesSent = 0,
    string? Version = null, string? Mode = null, ulong StorageBytes = 0,
    HostSettings? Settings = null, bool TelemetryAvailable = false);

/// <summary>
/// What the Windows service says about itself to a client, separately from the host it supervises:
/// its own version (an app update does not replace the copy the service runs) and whether the host
/// is up.
/// </summary>
public sealed record ServiceStatus(string Version, string Host, int Restarts);

public sealed record HostMessage(int Protocol, string Kind, string? RunId, HostSnapshot? Snapshot, ulong Sequence,
    string? RequestId = null, bool Ok = false, ServiceStatus? Service = null);

public static class HostProtocol
{
    /// <summary>
    /// 2: settings replaced the local subscription command, snapshots describe the host, and the
    /// Windows service adds its own <c>service</c> messages.
    /// </summary>
    public const int Version = 2;
    public const int MaxLineLength = 1024 * 1024;
    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);

    public static HostMessage Parse(string line)
    {
        if (line.Length > MaxLineLength) throw new InvalidDataException("Host message too large.");
        var message = JsonSerializer.Deserialize<HostMessage>(line, Options);
        if (message is null || message.Protocol != Version)
            throw new InvalidDataException("Incompatible repeater host.");
        if (message.Kind == "service")
        {
            if (message.Service is not { Version.Length: > 0, Host.Length: > 0 })
                throw new InvalidDataException("Invalid service status.");
            return message;
        }
        if (string.IsNullOrEmpty(message.RunId))
            throw new InvalidDataException("Incompatible repeater host.");
        if (message.Kind == "snapshot")
        {
            if (message.Snapshot is not { Members: not null, EndpointId: not null } snapshot ||
                snapshot.Missing > snapshot.Tracked)
                throw new InvalidDataException("Invalid repeater status.");
            if (snapshot.ClaimUrl is { } claim &&
                (!Uri.TryCreate(claim, UriKind.Absolute, out var uri) ||
                 uri.Scheme != "https" || uri.Host != "streetcrypt.id" ||
                 uri.AbsolutePath != "/repeater" || uri.Query.Length != 0 ||
                 uri.Fragment.Length == 0))
                throw new InvalidDataException("Invalid claim link.");
        }
        else if (message.Kind == "result")
        {
            if (string.IsNullOrEmpty(message.RequestId))
                throw new InvalidDataException("Missing command identity.");
        }
        else if (message.Kind != "arrival") throw new InvalidDataException("Unknown host message.");
        return message;
    }

    public static string SettingsCommand(string requestId, HostSettings settings)
    {
        if (requestId.Length is 0 or > 64) throw new ArgumentException("Invalid request id.", nameof(requestId));
        return JsonSerializer.Serialize(new
        {
            protocol = Version,
            kind = "settings",
            requestId,
            telemetry = settings.Telemetry,
            keepAwake = settings.KeepAwake
        }, Options);
    }

    /// <summary>
    /// The only thing an app may ask of the host: its settings, in exactly the shape
    /// <see cref="SettingsCommand"/> writes. The Windows service forwards nothing else, so a
    /// client that can reach its pipe still cannot speak the host's protocol in general.
    /// </summary>
    public static bool IsSettingsCommand(string line)
    {
        try
        {
            using var document = JsonDocument.Parse(line);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return false;
            var seen = new HashSet<string>();
            foreach (var property in root.EnumerateObject())
            {
                bool ok = seen.Add(property.Name) && property.Name switch
                {
                    "protocol" => property.Value.ValueKind == JsonValueKind.Number &&
                                  property.Value.TryGetInt32(out int protocol) && protocol == Version,
                    "kind" => property.Value.ValueKind == JsonValueKind.String &&
                              property.Value.GetString() == "settings",
                    "requestId" => property.Value.ValueKind == JsonValueKind.String &&
                                   property.Value.GetString() is { Length: > 0 and <= 64 },
                    "telemetry" or "keepAwake" => property.Value.ValueKind is JsonValueKind.True or JsonValueKind.False,
                    _ => false,
                };
                if (!ok) return false;
            }
            return seen.Count == 5;
        }
        catch (JsonException) { return false; }
    }

    public static async IAsyncEnumerable<string> ReadLines(
        TextReader reader,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var pending = new StringBuilder();
        char[] buffer = new char[4096];
        int read;
        while ((read = await reader.ReadAsync(buffer.AsMemory(), cancellationToken)) > 0)
        {
            for (int i = 0; i < read; i++)
            {
                char character = buffer[i];
                if (character == '\n')
                {
                    yield return pending.ToString().TrimEnd('\r');
                    pending.Clear();
                }

                else
                {
                    if (pending.Length >= MaxLineLength)
                        throw new InvalidDataException("Host message too large.");
                    pending.Append(character);
                }
            }
        }
        if (pending.Length != 0) throw new InvalidDataException("Incomplete host message.");
    }
}

public sealed class ArrivalTracker
{
    private bool ready;
    private ulong sequence;

    public bool Observe(ulong received, bool snapshot)
    {
        bool changed = ready && received > sequence;
        sequence = Math.Max(sequence, received);
        ready |= snapshot;
        return changed;
    }

    /// <summary>A new host run counts from zero again; its first snapshot is the new baseline.</summary>
    public void Reset()
    {
        ready = false;
        sequence = 0;
    }
}
