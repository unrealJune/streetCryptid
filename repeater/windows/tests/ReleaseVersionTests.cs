using StreetCryptid.Repeater.Core;
using Xunit;

namespace StreetCryptid.Repeater.Tests;

public class ReleaseVersionTests
{
    private static ReleaseVersion V(string text) =>
        ReleaseVersion.TryParse(text, out var version) ? version : throw new FormatException(text);

    [Theory]
    [InlineData("0.1.0-preview.1", "0.1.0-preview.2")]
    [InlineData("0.1.0-preview.2", "0.1.0-preview.10")]
    [InlineData("0.1.0-preview.9", "0.1.0")]
    [InlineData("0.1.0", "0.1.1-preview.1")]
    [InlineData("0.1.9", "0.2.0-preview.1")]
    [InlineData("0.9.0", "0.10.0")]
    [InlineData("1.0.0-alpha", "1.0.0-alpha.1")]
    [InlineData("1.0.0-alpha.1", "1.0.0-beta")]
    [InlineData("1.0.0-1", "1.0.0-alpha")]
    public void OrdersBySemVerPrecedence(string lower, string higher)
    {
        Assert.True(V(lower).CompareTo(V(higher)) < 0);
        Assert.True(V(higher).CompareTo(V(lower)) > 0);
    }

    [Fact]
    public void TheSameVersionIsNotNewer() => Assert.Equal(0, V("0.1.0-preview.1").CompareTo(V("0.1.0-preview.1")));

    [Theory]
    [InlineData("")]
    [InlineData("1.0")]
    [InlineData("1.0.0.0")]
    [InlineData("01.0.0")]
    [InlineData("1.0.0-")]
    [InlineData("1.0.0-pre..1")]
    [InlineData("1.0.0-pre.01")]
    [InlineData("1.0.0+build")]
    [InlineData("1.0.0/../../x")]
    [InlineData("v1.0.0")]
    public void RefusesAnythingThatIsNotAReleaseVersion(string text) =>
        Assert.False(ReleaseVersion.TryParse(text, out _));

    [Fact]
    public void TheUpdaterUrlNamesTheVersionedRelease() => Assert.Equal(
        "https://github.com/unrealJune/streetCryptid/releases/download/windows-v0.2.0-preview.1/" +
        "StreetCryptid.Repeater.Service-win-arm64.zip",
        ServiceLayout.ServiceArchiveUrl(V("0.2.0-preview.1"), "win-arm64"));
}
