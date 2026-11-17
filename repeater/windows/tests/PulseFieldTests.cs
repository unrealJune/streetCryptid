using StreetCryptid.Repeater.Core;
using Xunit;

namespace StreetCryptid.Repeater.Tests;

public class PulseFieldTests
{
    [Fact]
    public void IdleIsGreenAndArrivalsUseDifferentAccents()
    {
        var field = new PulseField(new Random(5));
        field.SetEnabled(true, 0);
        field.Tick(2, 1000, 700, []);
        Assert.True(field.Pulses.Single().Ambient);
        Assert.Equal(0, field.Pulses.Single().Color);
        field.Receive(2.1, 1000, 700, []);
        field.Receive(2.3, 1000, 700, []);
        Assert.False(field.Pulses[1].Ambient);
        Assert.NotEqual(0, field.Pulses[1].Color);
        Assert.NotEqual(field.Pulses[1].Color, field.Pulses[2].Color);
    }

    [Fact]
    public void IdleWaveHasAVisibleFrontAndContinuesWithoutNetworkTraffic()
    {
        var pulse = new Pulse(new(0, 0), 0, 0, true);
        double front = Enumerable.Range(0, 12).Max(i => pulse.Heat(new(90, 0), 0.6 + i * 0.025));
        Assert.True(front >= 0.5, "Idle dots must reach at least half opacity, not disappear into the lattice.");
        Assert.True(pulse.Heat(new(90, 0), 0.4) < front);
        Assert.True(pulse.Heat(new(90, 0), 1.4) < front / 2);

        var field = new PulseField(new Random(5));
        field.SetEnabled(true, 0);
        field.Tick(1, 1000, 700, []);
        field.Tick(3.2, 1000, 700, []);
        Assert.Equal(2, field.Pulses.Count);
        Assert.All(field.Pulses, p => Assert.True(p.Ambient));
    }

    [Fact]
    public void DotsPopAtTheOriginThenRadiateOutward()
    {
        var pulse = new Pulse(new(0, 0), 0, 1, false);
        FieldPoint origin = new(0, 0);
        FieldPoint near = new(60, 0);
        FieldPoint far = new(150, 0);

        Assert.True(pulse.Heat(origin, 0.08) > 0.8);
        Assert.Equal(0, pulse.Heat(near, 0.08));
        Assert.Equal(0, pulse.Heat(far, 0.08));
        Assert.True(pulse.Heat(near, 0.6) > 0.5);
        Assert.Equal(0, pulse.Heat(far, 0.6));
        Assert.True(pulse.Heat(far, 1.2) > 0.5);
        Assert.Equal(0, pulse.Heat(origin, 1.2));
        Assert.Equal(0, pulse.Heat(far, 3));
    }

    [Fact]
    public void EquidistantDotsPopIndividuallyRatherThanAsASmoothRing()
    {
        var pulse = new Pulse(new(0, 0), 0, 1, false);
        Assert.Contains(Enumerable.Range(0, 20), i =>
        {
            double now = 0.6 + i * 0.02;
            return Math.Abs(pulse.Heat(new(90, 0), now) - pulse.Heat(new(0, 90), now)) > 0.1;
        });
    }

    [Fact]
    public void HiddenEventsAreDiscardedAndResumeDoesNotReplayThem()
    {
        var field = new PulseField(new Random(5));
        field.SetEnabled(true, 0);
        field.Receive(1, 1000, 700, []);
        field.SetEnabled(false, 2);
        field.Receive(3, 1000, 700, []);
        field.Tick(8, 1000, 700, []);
        field.SetEnabled(true, 10);
        Assert.Empty(field.Pulses);
        field.Tick(10.5, 1000, 700, []);
        Assert.Empty(field.Pulses);
    }

    [Fact]
    public void BurstsAreCoalescedAndBounded()
    {
        var field = new PulseField(new Random(5));
        field.SetEnabled(true, 0);
        for (int i = 0; i < 1000; i++) field.Receive(1, 1000, 700, []);
        Assert.Single(field.Pulses);
        for (int i = 0; i < 1000; i++) field.Receive(2 + i * 0.2, 1000, 700, []);
        Assert.Equal(PulseField.MaxPulses, field.Pulses.Count);
        field.Tick(205, 0, 0, []);
        Assert.Empty(field.Pulses);
    }

    [Fact]
    public void OriginsStayOffThePanelAndHeatCools()
    {
        var field = new PulseField(new Random(5));
        field.SetEnabled(true, 0);
        FieldRect panel = new(200, 150, 600, 400);
        for (int i = 0; i < 10; i++) field.Receive(i, 1000, 700, [panel]);
        Assert.All(field.Pulses, p => Assert.False(panel.Contains(p.Origin, 24)));
        var pulse = new Pulse(new(0, 0), 0, 1, false);
        Assert.Equal(0, pulse.Heat(new(150, 0), 0));
        Assert.True(pulse.Heat(new(150, 0), 1.2) > pulse.Heat(new(150, 0), 2));
        Assert.Equal(0, pulse.Heat(new(150, 0), 3));
    }
}
