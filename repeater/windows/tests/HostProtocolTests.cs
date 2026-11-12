using StreetCryptid.Repeater.Core;
using Xunit;

namespace StreetCryptid.Repeater.Tests;

public class HostProtocolTests
{
    [Fact]
    public void SnapshotRacingAnArrivalStillPingsExactlyOnce()
    {
        var tracker = new ArrivalTracker();
        Assert.False(tracker.Observe(10, true));
        Assert.True(tracker.Observe(11, true));
        Assert.False(tracker.Observe(11, false));
        Assert.True(tracker.Observe(12, false));
        Assert.False(tracker.Observe(12, true));
        Assert.False(tracker.Observe(10, true));
    }

    [Fact]
    public void ARestartedHostStartsANewBaseline()
    {
        var tracker = new ArrivalTracker();
        Assert.False(tracker.Observe(5, true));
        tracker.Reset();
        Assert.False(tracker.Observe(1, true));
        Assert.True(tracker.Observe(2, false));
    }

    [Fact]
    public void StartupArrivalsAreNotReplayed()
    {
        var tracker = new ArrivalTracker();
        Assert.False(tracker.Observe(3, false));
        Assert.False(tracker.Observe(3, true));
        Assert.True(tracker.Observe(4, false));
    }

    [Fact]
    public void SettingsCommandIsCorrelatedAndRepliesAreChecked()
    {
        var command = HostProtocol.SettingsCommand("test", new HostSettings(true, false));
        Assert.Contains("\"protocol\":2", command);
        Assert.Contains("\"kind\":\"settings\"", command);
        Assert.Contains("\"keepAwake\":false", command);
        Assert.Throws<ArgumentException>(() => HostProtocol.SettingsCommand("", new HostSettings(true, true)));
        var reply = HostProtocol.Parse("{\"protocol\":2,\"kind\":\"result\",\"runId\":\"run\",\"requestId\":\"test\",\"ok\":true}");
        Assert.True(reply.Ok);
        Assert.Equal("test", reply.RequestId);
        Assert.Throws<InvalidDataException>(() =>
            HostProtocol.Parse("{\"protocol\":2,\"kind\":\"result\",\"runId\":\"run\",\"ok\":true}"));
    }

    [Fact]
    public void SnapshotsCarryTheHostsOwnState()
    {
        var message = HostProtocol.Parse(
            "{\"protocol\":2,\"kind\":\"snapshot\",\"runId\":\"run\",\"snapshot\":{\"protocol\":2," +
            "\"version\":\"0.2.0\",\"mode\":\"service\",\"endpointId\":\"ab\",\"claimed\":true," +
            "\"members\":[],\"tracked\":2,\"missing\":1,\"received\":3," +
            "\"settings\":{\"telemetry\":true,\"keepAwake\":true},\"telemetryAvailable\":true}}");
        Assert.Equal("service", message.Snapshot!.Mode);
        Assert.Equal(new HostSettings(true, true), message.Snapshot.Settings);
    }

    [Fact]
    public void ServiceStatusNeedsNoRunAndAnOlderProtocolIsRefused()
    {
        var status = HostProtocol.Parse(
            "{\"protocol\":2,\"kind\":\"service\",\"service\":{\"version\":\"0.2.0\",\"host\":\"running\",\"restarts\":0}}");
        Assert.Equal("running", status.Service!.Host);
        Assert.Throws<InvalidDataException>(() =>
            HostProtocol.Parse("{\"protocol\":2,\"kind\":\"service\",\"service\":{\"version\":\"\",\"host\":\"x\"}}"));
        Assert.Throws<InvalidDataException>(() =>
            HostProtocol.Parse("{\"protocol\":1,\"kind\":\"arrival\",\"runId\":\"run\",\"sequence\":1}"));
    }

    [Fact]
    public void OnlyWellFormedSettingsCommandsPassTheService()
    {
        Assert.True(HostProtocol.IsSettingsCommand(HostProtocol.SettingsCommand("abc", new HostSettings(false, true))));
        Assert.False(HostProtocol.IsSettingsCommand("{\"protocol\":2,\"kind\":\"settings\",\"requestId\":\"a\",\"telemetry\":true}"));
        Assert.False(HostProtocol.IsSettingsCommand(
            "{\"protocol\":2,\"kind\":\"subscription\",\"requestId\":\"a\",\"telemetry\":true,\"keepAwake\":true}"));
        Assert.False(HostProtocol.IsSettingsCommand(
            "{\"protocol\":2,\"protocol\":2,\"requestId\":\"a\",\"telemetry\":true,\"keepAwake\":true}"));
        Assert.False(HostProtocol.IsSettingsCommand(
            "{\"protocol\":2,\"kind\":\"settings\",\"requestId\":\"a\",\"telemetry\":1,\"keepAwake\":true}"));
        Assert.False(HostProtocol.IsSettingsCommand("not json"));
    }

    [Fact]
    public void OnlyWellFormedReleaseCommandsPassTheService()
    {
        string release = HostProtocol.ReleaseCommand("abc");
        Assert.Contains("\"kind\":\"release\"", release);
        Assert.True(HostProtocol.IsHostCommand(release));
        Assert.False(HostProtocol.IsSettingsCommand(release));
        Assert.True(HostProtocol.IsHostCommand(HostProtocol.SettingsCommand("abc", new HostSettings(true, true))));
        Assert.False(HostProtocol.IsHostCommand(
            "{\"protocol\":2,\"kind\":\"release\",\"requestId\":\"a\",\"telemetry\":true}"));
        Assert.False(HostProtocol.IsHostCommand("{\"protocol\":2,\"kind\":\"release\"}"));
        Assert.False(HostProtocol.IsHostCommand("{\"protocol\":2,\"kind\":\"claim\",\"requestId\":\"a\"}"));
        Assert.Throws<ArgumentException>(() => HostProtocol.ReleaseCommand(""));
    }

    [Fact]
    public void OnlyWellFormedNameCommandsPassTheService()
    {
        string name = HostProtocol.NameCommand("abc", "Living room PC");
        Assert.Contains("\"kind\":\"name\"", name);
        Assert.True(HostProtocol.IsHostCommand(name));
        Assert.True(HostProtocol.IsHostCommand(HostProtocol.NameCommand("abc", "")));
        Assert.False(HostProtocol.IsSettingsCommand(name));
        // A name on any other command, a missing name, or a name that is not a string.
        Assert.False(HostProtocol.IsHostCommand(
            "{\"protocol\":2,\"kind\":\"release\",\"requestId\":\"a\",\"name\":\"x\"}"));
        Assert.False(HostProtocol.IsHostCommand("{\"protocol\":2,\"kind\":\"name\",\"requestId\":\"a\"}"));
        Assert.False(HostProtocol.IsHostCommand(
            "{\"protocol\":2,\"kind\":\"name\",\"requestId\":\"a\",\"name\":7}"));
        Assert.Throws<ArgumentException>(() => HostProtocol.NameCommand("abc", new string('x', 201)));
    }

    [Fact]
    public void SnapshotsCarryTheNameAndWhatPhonesShow()
    {
        var message = HostProtocol.Parse(
            "{\"protocol\":2,\"kind\":\"snapshot\",\"runId\":\"r\",\"snapshot\":{\"endpointId\":\"ab\"," +
            "\"claimed\":true,\"members\":[],\"tracked\":0,\"missing\":0,\"received\":0," +
            "\"name\":\"Attic PC\",\"listedName\":\"Old name\"}}");
        Assert.Equal("Attic PC", message.Snapshot!.Name);
        Assert.Equal("Old name", message.Snapshot.ListedName);
    }

    [Theory]
    [InlineData("{\"protocol\":3,\"kind\":\"arrival\",\"runId\":\"test\",\"sequence\":1}")]
    [InlineData("{\"protocol\":2,\"kind\":\"arrival\",\"runId\":\"\"}")]
    [InlineData("{\"protocol\":2,\"kind\":\"snapshot\",\"runId\":\"test\"}")]
    public void InvalidMessagesAreRejected(string json) =>
        Assert.Throws<InvalidDataException>(() => HostProtocol.Parse(json));

    [Fact]
    public async Task FramingHandlesCrlfAndRejectsAnUnterminatedOversizedLine()
    {
        var lines = new List<string>();
        await foreach (string line in HostProtocol.ReadLines(new StringReader("one\r\ntwo\n"), default))
            lines.Add(line);
        Assert.Equal(["one", "two"], lines);
        await Assert.ThrowsAsync<InvalidDataException>(async () =>
        {
            await foreach (var _ in HostProtocol.ReadLines(
                new StringReader(new string('x', HostProtocol.MaxLineLength + 1)), default)) { }
        });
    }
}
