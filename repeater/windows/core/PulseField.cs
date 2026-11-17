namespace StreetCryptid.Repeater.Core;

public readonly record struct FieldPoint(double X, double Y);
public readonly record struct FieldRect(double X, double Y, double Width, double Height)
{
    public bool Contains(FieldPoint point, double margin = 0) =>
        point.X >= X - margin && point.X <= X + Width + margin &&
        point.Y >= Y - margin && point.Y <= Y + Height + margin;
}

public readonly record struct Pulse(FieldPoint Origin, double Started, int Color, bool Ambient)
{
    public const double Duration = 2.4;
    public const double Reach = 230;

    public double Heat(FieldPoint dot, double now)
    {
        double age = now - Started;
        if (age <= 0 || age > Duration) return 0;
        double dx = dot.X - Origin.X;
        double dy = dot.Y - Origin.Y;
        double distance = Math.Sqrt(dx * dx + dy * dy);
        if (distance >= Reach) return 0;

        const double rise = 0.1;
        const double fade = 0.44;
        const double scatter = 0.14;
        double waveAge = age - distance / 150;
        if (waveAge <= 0 || waveAge >= rise + fade + scatter) return 0;
        double since = waveAge - DotJitter(dot) * scatter * Math.Min(distance / 30, 1);
        if (since <= 0 || since >= rise + fade) return 0;

        double pop = since < rise
            ? 1 - Math.Pow(1 - since / rise, 3)
            : Math.Pow(1 - (since - rise) / fade, 2);
        double falloff = (1 - distance / (2 * Reach)) * Math.Min(1, (Reach - distance) / 50);
        return pop * falloff * (Ambient ? 0.85 : 1);
    }

    private static double DotJitter(FieldPoint dot)
    {
        long x = (long)Math.Floor(dot.X / PulseField.Step);
        long y = (long)Math.Floor(dot.Y / PulseField.Step);
        long hash = unchecked((x * 73856093) ^ (y * 19349663));
        hash ^= hash >> 13;
        return (hash & 255) / 255.0;
    }
}

public sealed class PulseField
{
    public const int MaxPulses = 8;
    public const double Step = 15;
    private readonly Random random;
    private readonly List<Pulse> pulses = [];
    private double lastArrival = double.NegativeInfinity;
    private double nextAmbient;
    private int lastColor = -1;
    private bool enabled;

    public PulseField(Random? random = null) => this.random = random ?? Random.Shared;
    public IReadOnlyList<Pulse> Pulses => pulses;

    public void SetEnabled(bool value, double now)
    {
        if (enabled == value) return;
        enabled = value;
        pulses.Clear();
        nextAmbient = now + 1;
        lastArrival = double.NegativeInfinity;
    }

    public void Tick(double now, double width, double height, IReadOnlyList<FieldRect> excluded)
    {
        if (!enabled) return;
        pulses.RemoveAll(p => now - p.Started > Pulse.Duration);
        if (now < nextAmbient) return;
        nextAmbient = now + 1.6 + random.NextDouble() * 0.5;
        Add(now, width, height, excluded, true);
    }

    public void Receive(double now, double width, double height, IReadOnlyList<FieldRect> excluded)
    {
        if (!enabled || now - lastArrival < 0.15) return;
        lastArrival = now;
        Add(now, width, height, excluded, false);
    }

    private void Add(double now, double width, double height, IReadOnlyList<FieldRect> excluded, bool ambient)
    {
        if (width < Step * 2 || height < Step * 2) return;
        FieldPoint? origin = null;
        for (int attempt = 0; attempt < 32; attempt++)
        {
            var candidate = new FieldPoint(
                (random.Next(Math.Max(1, (int)(width / Step) - 1)) + 0.5) * Step,
                (random.Next(Math.Max(1, (int)(height / Step) - 1)) + 0.5) * Step);
            if (excluded.Any(rect => rect.Contains(candidate, 24))) continue;
            origin = candidate;
            break;
        }
        if (origin is null) return;
        int color = 0;
        if (!ambient)
        {
            color = random.Next(1, 6);
            if (color == lastColor) color = color % 5 + 1;
            lastColor = color;
        }
        if (pulses.Count >= MaxPulses) pulses.RemoveAt(0);
        pulses.Add(new Pulse(origin.Value, now, color, ambient));
    }
}
