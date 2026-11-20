using System.Text;
using System.Text.Json;

namespace StreetCryptid.Repeater.Core;

/// <summary>Choices the host keeps for this machine (see the Rust host's <c>HostSettings</c>).</summary>
public sealed record HostSettings(bool Telemetry, bool KeepAwake);
public sealed record RelayStatus(string Url, bool HasAuthToken);
public sealed record NetworkStatus(RelayStatus[] Relays, string TelemetryEndpoint, bool RestartRequired);
public sealed class RelayConfig(string url, string? authToken)
{
    public string Url { get; } = url;
    public string? AuthToken { get; } = authToken;
    public override string ToString() => "RelayConfig { [redacted] }";
}
public sealed record NetworkConfig(RelayConfig[] Relays, string TelemetryEndpoint);

public sealed record HostSnapshot(
    string EndpointId, bool Claimed, string? ClaimUrl, string? Owner,
    string? Policy, string[] Members, ulong Tracked, ulong Missing, ulong Received,
    ulong Connections = 0, ulong ConnectionsOpened = 0,
    ulong BytesReceived = 0, ulong BytesSent = 0,
    string? Version = null, string? Mode = null,
    HostSettings? Settings = null, bool TelemetryAvailable = false,
    string? Name = null, string? ListedName = null, NetworkStatus? Network = null);

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
                 !IsClaimPath(uri.AbsolutePath) || uri.Query.Length != 0 ||
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

    /// <summary>
    /// <c>/repeater/claim</c>, what <c>wire::claim_url</c> prints, or <c>/repeater</c>, what it
    /// printed before that path became the setup guide: the service's host can be older than the
    /// app reading it.
    /// </summary>
    public static bool IsClaimPath(string path) => path is "/repeater/claim" or "/repeater";

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

    public static string NetworkCommand(string requestId, NetworkConfig network)
    {
        if (requestId.Length is 0 or > 64) throw new ArgumentException("Invalid request id.", nameof(requestId));
        string line = JsonSerializer.Serialize(new { protocol = Version, kind = "network", requestId, network }, Options);
        if (!IsCommand(line, "network")) throw new ArgumentException("Invalid network settings.");
        return line;
    }

    /// <summary>
    /// Release this repeater from its roster (REPEATERS.md §4.1): it stops carrying everyone and
    /// shows a new claim code. The only roster decision the person at the machine can make.
    /// </summary>
    public static string ReleaseCommand(string requestId)
    {
        if (requestId.Length is 0 or > 64) throw new ArgumentException("Invalid request id.", nameof(requestId));
        return JsonSerializer.Serialize(new { protocol = Version, kind = "release", requestId }, Options);
    }

    /// <summary>The longest name a repeater carries, in characters (the protocol's <c>MAX_REPEATER_NAME</c>).</summary>
    public const int MaxNameLength = 40;

    /// <summary>
    /// Name this repeater (empty clears it). The name is signed into the cert the machine gives
    /// its owner's phone, so it shows in the app wherever the machine is.
    /// </summary>
    public static string NameCommand(string requestId, string name)
    {
        if (requestId.Length is 0 or > 64) throw new ArgumentException("Invalid request id.", nameof(requestId));
        if (name.Length > 200) throw new ArgumentException("Name too long.", nameof(name));
        return JsonSerializer.Serialize(new { protocol = Version, kind = "name", requestId, name }, Options);
    }

    /// <summary>
    /// Whether <paramref name="line"/> is one of the things an app may ask of the host, in exactly
    /// the shape <see cref="SettingsCommand"/>, <see cref="NameCommand"/> or
    /// <see cref="ReleaseCommand"/> writes. The Windows service forwards nothing else, so a client
    /// that can reach its pipe still cannot speak the host's protocol in general.
    /// </summary>
    public static bool IsHostCommand(string line) =>
        IsCommand(line, "settings") || IsCommand(line, "name") || IsCommand(line, "release") || IsCommand(line, "network");

    /// <summary>A settings command, exactly as <see cref="SettingsCommand"/> writes it.</summary>
    public static bool IsSettingsCommand(string line) => IsCommand(line, "settings");

    private static bool IsCommand(string line, string kind)
    {
        if (Encoding.UTF8.GetByteCount(line) + 1 > 4096) return false;
        bool settings = kind == "settings";
        bool naming = kind == "name";
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
                              property.Value.GetString() == kind,
                    "requestId" => property.Value.ValueKind == JsonValueKind.String &&
                                   property.Value.GetString() is { Length: > 0 and <= 64 },
                    "telemetry" or "keepAwake" => settings &&
                        property.Value.ValueKind is JsonValueKind.True or JsonValueKind.False,
                    "name" => naming && property.Value.ValueKind == JsonValueKind.String &&
                              property.Value.GetString() is { Length: <= 200 },
                    "network" => kind == "network" && IsNetwork(property.Value),
                    _ => false,
                };
                if (!ok) return false;
            }
            return seen.Count == (settings ? 5 : naming || kind == "network" ? 4 : 3);
        }
        catch (JsonException) { return false; }
    }

    private static bool IsNetwork(JsonElement network)
    {
        if (network.ValueKind != JsonValueKind.Object) return false;
        var fields = new HashSet<string>();
        foreach (var field in network.EnumerateObject())
        {
            if (!fields.Add(field.Name)) return false;
            if (field.Name == "telemetryEndpoint")
            {
                if (field.Value.ValueKind != JsonValueKind.String || field.Value.GetString()!.Length > 2048) return false;
            }
            else if (field.Name == "relays")
            {
                if (field.Value.ValueKind != JsonValueKind.Array || field.Value.GetArrayLength() > 8) return false;
                foreach (var relay in field.Value.EnumerateArray())
                {
                    if (relay.ValueKind != JsonValueKind.Object) return false;
                    var keys = new HashSet<string>();
                    foreach (var key in relay.EnumerateObject())
                    {
                        if (!keys.Add(key.Name)) return false;
                        if (key.Name == "url")
                        {
                            if (key.Value.ValueKind != JsonValueKind.String || key.Value.GetString() is not { Length: > 0 and <= 2048 }) return false;
                        }
                        else if (key.Name == "authToken")
                        {
                            if (key.Value.ValueKind != JsonValueKind.Null &&
                                (key.Value.ValueKind != JsonValueKind.String || key.Value.GetString()!.Length > 512)) return false;
                        }
                        else return false;
                    }
                    if (!keys.Contains("url")) return false;
                }
            }
            else return false;
        }
        return fields.SetEquals(["relays", "telemetryEndpoint"]);
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
