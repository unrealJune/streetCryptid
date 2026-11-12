using System.Text.Json;
using System.Text.Json.Serialization;

namespace StreetCryptid.Repeater.Core;

public sealed record Preferences
{
    public int Version { get; init; } = 1;
    public bool SetupComplete { get; init; }
    public bool StartWithWindows { get; init; }
    public bool StartInTray { get; init; } = true;
    public bool CloseToTray { get; init; } = true;
    public bool AutoUpdate { get; init; } = true;
    /// <summary>
    /// Run the repeater as a Windows service, so it carries before sign-in and after sign-out.
    /// Null for a setup finished before the choice existed: that install keeps running per user
    /// until the person turns the service on in Settings.
    /// </summary>
    public bool? RunAsService { get; init; }

    [JsonIgnore] public bool UsesService => RunAsService == true;
    /// <summary>What this person chose for the host; the app brings the host into line on every connection.</summary>
    public bool Telemetry { get; init; } = true;
    public bool KeepAwake { get; init; }

    [JsonIgnore] public HostSettings HostSettings => new(Telemetry, KeepAwake);
}

public sealed class PreferencesStore(string directory)
{
    private readonly string path = Path.Combine(directory, "settings.json");
    private static readonly JsonSerializerOptions Options = new() { WriteIndented = true };

    public Preferences Load()
    {
        if (!File.Exists(path)) return new();
        var preferences = JsonSerializer.Deserialize<Preferences>(File.ReadAllText(path))
            ?? throw new InvalidDataException("Settings are damaged.");
        if (preferences.Version != 1) throw new InvalidDataException("Unsupported settings version.");
        return preferences;
    }

    public void Save(Preferences preferences)
    {
        Directory.CreateDirectory(directory);
        string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                JsonSerializer.Serialize(stream, preferences, Options);
                stream.Flush(true);
            }
            File.Move(temporary, path, true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }
}
