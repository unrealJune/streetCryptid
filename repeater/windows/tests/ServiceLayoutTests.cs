using StreetCryptid.Repeater.Core;
using Xunit;

namespace StreetCryptid.Repeater.Tests;

public sealed class StateMigrationTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "sc-migrate-" + Guid.NewGuid());
    private string User => Path.Combine(root, "user");
    private string Service => Path.Combine(root, "service");

    public StateMigrationTests()
    {
        Directory.CreateDirectory(User);
        File.WriteAllBytes(Path.Combine(User, "secret.key"), [1, 2, 3]);
        File.WriteAllText(Path.Combine(User, "roster.bin"), "roster");
        File.WriteAllText(Path.Combine(User, "settings.json"), "{}");
        File.WriteAllText(Path.Combine(User, "host.lock"), "");
        Directory.CreateDirectory(Path.Combine(User, "blobs", "data"));
        File.WriteAllText(Path.Combine(User, "blobs", "data", "x"), "ciphertext");
    }

    public void Dispose()
    {
        if (Directory.Exists(root)) Directory.Delete(root, true);
    }

    [Fact]
    public void NodeStateMovesAndThePreferencesStay()
    {
        Assert.Equal(ServiceVerbResult.Ok, StateMigration.Move(User, Service));
        Assert.Equal([1, 2, 3], File.ReadAllBytes(Path.Combine(Service, "secret.key")));
        Assert.Equal("ciphertext", File.ReadAllText(Path.Combine(Service, "blobs", "data", "x")));
        Assert.False(File.Exists(Path.Combine(Service, "settings.json")));
        Assert.False(File.Exists(Path.Combine(Service, "host.lock")));
        Assert.False(StateMigration.HasIdentity(User));
        Assert.False(Directory.Exists(Path.Combine(User, "blobs")));
        Assert.True(File.Exists(Path.Combine(User, "settings.json")));
        Assert.False(Directory.Exists(Service + ".incoming"));
    }

    [Fact]
    public void TheMoveBackIsTheSameMove()
    {
        StateMigration.Move(User, Service);
        Assert.Equal(ServiceVerbResult.Ok, StateMigration.Move(Service, User));
        Assert.Equal([1, 2, 3], File.ReadAllBytes(Path.Combine(User, "secret.key")));
        Assert.Equal("roster", File.ReadAllText(Path.Combine(User, "roster.bin")));
        Assert.False(StateMigration.HasIdentity(Service));
    }

    [Fact]
    public void ADifferentIdentityAtTheDestinationIsNeverOverwritten()
    {
        Directory.CreateDirectory(Service);
        File.WriteAllBytes(Path.Combine(Service, "secret.key"), [9]);
        Assert.Equal(ServiceVerbResult.IdentityConflict, StateMigration.Move(User, Service));
        Assert.Equal([9], File.ReadAllBytes(Path.Combine(Service, "secret.key")));
        Assert.Equal([1, 2, 3], File.ReadAllBytes(Path.Combine(User, "secret.key")));
    }

    [Fact]
    public void KeylessStateAtTheDestinationIsAConflictToo()
    {
        Directory.CreateDirectory(Service);
        File.WriteAllText(Path.Combine(Service, "roster.bin"), "someone else's");
        Assert.Equal(ServiceVerbResult.IdentityConflict, StateMigration.Move(User, Service));
        Assert.True(StateMigration.HasIdentity(User));
    }

    [Fact]
    public void AnInterruptedSwapIsFinishedByRunningAgain()
    {
        string staging = Service + ".incoming";
        Directory.CreateDirectory(staging);
        File.Copy(Path.Combine(User, "roster.bin"), Path.Combine(staging, "roster.bin"));
        File.Copy(Path.Combine(User, "secret.key"), Path.Combine(staging, "secret.key"));
        Directory.CreateDirectory(Service);
        Assert.Equal(ServiceVerbResult.Ok, StateMigration.Move(User, Service));
        Assert.Equal([1, 2, 3], File.ReadAllBytes(Path.Combine(Service, "secret.key")));
        Assert.False(Directory.Exists(staging));
        Assert.False(StateMigration.HasIdentity(User));
    }

    [Fact]
    public void AFinishedCopyWithAnUndeletedSourceIsCompleted()
    {
        Directory.CreateDirectory(Service);
        File.WriteAllBytes(Path.Combine(Service, "secret.key"), [1, 2, 3]);
        Assert.Equal(ServiceVerbResult.Ok, StateMigration.Move(User, Service));
        Assert.False(StateMigration.HasIdentity(User));
    }

    [Fact]
    public void NothingToMoveIsNotAnError()
    {
        string empty = Path.Combine(root, "empty");
        Directory.CreateDirectory(empty);
        Assert.Equal(ServiceVerbResult.Ok, StateMigration.Move(empty, Service));
        Assert.False(StateMigration.HasIdentity(Service));
    }
}

public class ServiceLayoutTests
{
    [Theory]
    [InlineData("plain", "plain")]
    [InlineData("", "\"\"")]
    [InlineData(@"C:\Users\June Philip\AppData", "\"C:\\Users\\June Philip\\AppData\"")]
    [InlineData(@"C:\dir with space\", "\"C:\\dir with space\\\\\"")]
    [InlineData("say \"hi\"", "\"say \\\"hi\\\"\"")]
    public void ArgumentsSurviveCommandLineToArgv(string argument, string expected) =>
        Assert.Equal(expected, ServiceLayout.Quote(argument));

    [Theory]
    [InlineData("secret.key", true)]
    [InlineData("docs", true)]
    [InlineData("host-settings.json", true)]
    [InlineData("settings.json", false)]
    [InlineData("host.lock", false)]
    [InlineData("moved-to-service", false)]
    [InlineData("host-settings.json.tmp", false)]
    public void OnlyNodeStateMoves(string name, bool moves) =>
        Assert.Equal(moves, StateMigration.IsNodeState(name));
}
