using System.Diagnostics.CodeAnalysis;

namespace StreetCryptid.Repeater.Core;

/// <summary>
/// A release's version, <c>MAJOR.MINOR.PATCH[-PRERELEASE]</c>, ordered by SemVer precedence. The
/// unattended service update compares with it so a request can only ever move the service forward.
/// Build metadata (<c>+...</c>) is not accepted: nothing we publish carries it in a tag.
/// </summary>
public sealed class ReleaseVersion : IComparable<ReleaseVersion>
{
    private readonly int[] core;
    private readonly string[] prerelease;

    private ReleaseVersion(int[] core, string[] prerelease, string text)
    {
        this.core = core;
        this.prerelease = prerelease;
        Text = text;
    }

    public string Text { get; }

    public static bool TryParse(string? text, [NotNullWhen(true)] out ReleaseVersion? version)
    {
        version = null;
        if (string.IsNullOrEmpty(text) || text.Length > 64) return false;
        int dash = text.IndexOf('-');
        string main = dash < 0 ? text : text[..dash];
        string[] parts = main.Split('.');
        if (parts.Length != 3) return false;
        var numbers = new int[3];
        for (int i = 0; i < 3; i++)
            if (!TryNumber(parts[i], out numbers[i])) return false;
        string[] pre = [];
        if (dash >= 0)
        {
            pre = text[(dash + 1)..].Split('.');
            foreach (string identifier in pre)
            {
                if (identifier.Length == 0 || !identifier.All(c => char.IsAsciiLetterOrDigit(c) || c == '-'))
                    return false;
                if (identifier.All(char.IsAsciiDigit) && !TryNumber(identifier, out _)) return false;
            }
        }
        version = new ReleaseVersion(numbers, pre, text);
        return true;
    }

    private static bool TryNumber(string text, out int value)
    {
        value = 0;
        if (text.Length == 0 || text.Length > 9 || !text.All(char.IsAsciiDigit)) return false;
        if (text.Length > 1 && text[0] == '0') return false;
        value = int.Parse(text, System.Globalization.CultureInfo.InvariantCulture);
        return true;
    }

    public int CompareTo(ReleaseVersion? other)
    {
        if (other is null) return 1;
        for (int i = 0; i < 3; i++)
            if (core[i] != other.core[i]) return core[i].CompareTo(other.core[i]);
        // A prerelease sorts before the release it leads to.
        if (prerelease.Length == 0 || other.prerelease.Length == 0)
            return Math.Sign(other.prerelease.Length.CompareTo(prerelease.Length));
        for (int i = 0; i < Math.Min(prerelease.Length, other.prerelease.Length); i++)
        {
            string a = prerelease[i], b = other.prerelease[i];
            bool aNumeric = a.All(char.IsAsciiDigit), bNumeric = b.All(char.IsAsciiDigit);
            int compared = (aNumeric, bNumeric) switch
            {
                (true, true) => int.Parse(a, System.Globalization.CultureInfo.InvariantCulture)
                    .CompareTo(int.Parse(b, System.Globalization.CultureInfo.InvariantCulture)),
                (true, false) => -1,
                (false, true) => 1,
                _ => string.CompareOrdinal(a, b),
            };
            if (compared != 0) return Math.Sign(compared);
        }
        return Math.Sign(prerelease.Length.CompareTo(other.prerelease.Length));
    }

    public override string ToString() => Text;
}
