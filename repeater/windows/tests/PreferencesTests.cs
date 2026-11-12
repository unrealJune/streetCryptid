using StreetCryptid.Repeater.Core;
using Xunit;

namespace StreetCryptid.Repeater.Tests;

public class PreferencesTests
{
    [Fact]
    public void ChoicesAndUnfinishedSetupSurviveReloadWithoutEnablingStartup()
    {
        string directory = Path.Combine(Path.GetTempPath(), "sc-settings-" + Guid.NewGuid());
        try
        {
            var store = new PreferencesStore(directory);
            var draft = store.Load() with { AutoUpdate = false, CloseToTray = false };
            store.Save(draft);
            Assert.Equal(draft, new PreferencesStore(directory).Load());
            Assert.False(store.Load().SetupComplete);
            Assert.False(store.Load().StartWithWindows);
            Assert.Single(Directory.GetFiles(directory));
        }
        finally
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, true);
        }
    }

    [Fact]
    public void ASetupFromBeforeTheServiceStaysPerUser()
    {
        string directory = Path.Combine(Path.GetTempPath(), "sc-settings-" + Guid.NewGuid());
        Directory.CreateDirectory(directory);
        try
        {
            File.WriteAllText(Path.Combine(directory, "settings.json"),
                "{\"Version\":1,\"SetupComplete\":true,\"StartWithWindows\":true}");
            var loaded = new PreferencesStore(directory).Load();
            Assert.Null(loaded.RunAsService);
            Assert.False(loaded.UsesService);
            Assert.Equal(new HostSettings(true, false), loaded.HostSettings);
        }
        finally { Directory.Delete(directory, true); }
    }

    [Fact]
    public void DamagedSettingsAreNotSilentlyOverwritten()
    {
        string directory = Path.Combine(Path.GetTempPath(), "sc-settings-" + Guid.NewGuid());
        Directory.CreateDirectory(directory);
        string path = Path.Combine(directory, "settings.json");
        try
        {
            File.WriteAllText(path, "broken");
            Assert.Throws<System.Text.Json.JsonException>(() => new PreferencesStore(directory).Load());
            Assert.Equal("broken", File.ReadAllText(path));
        }
        finally { Directory.Delete(directory, true); }
    }
}
