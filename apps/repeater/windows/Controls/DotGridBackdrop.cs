using System.Diagnostics;
using Microsoft.Graphics.Canvas;
using Microsoft.Graphics.Canvas.UI.Xaml;
using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using StreetCryptid.Repeater.Core;
using Windows.UI;
using Windows.UI.ViewManagement;

namespace StreetCryptid.Repeater.Controls;

public sealed class DotGridBackdrop : UserControl
{
    private readonly CanvasControl canvas = new();
    private readonly PulseField field = new();
    private readonly Stopwatch clock = Stopwatch.StartNew();
    private readonly UISettings uiSettings = new();
    private readonly AccessibilitySettings accessibility = new();
    private readonly Microsoft.UI.Dispatching.DispatcherQueueTimer frameTimer;
    private CanvasRenderTarget? lattice;
    private bool rendering;
    private bool visible;
    private bool dark;
    public IReadOnlyList<FieldRect> Excluded { get; set; } = [];

    private static readonly Color[] LightColors =
    [
        Color.FromArgb(255, 47, 158, 106), Color.FromArgb(255, 198, 121, 26),
        Color.FromArgb(255, 26, 132, 158), Color.FromArgb(255, 125, 83, 169),
        Color.FromArgb(255, 190, 80, 110), Color.FromArgb(255, 45, 114, 191)
    ];
    private static readonly Color[] DarkColors =
    [
        Color.FromArgb(255, 111, 208, 138), Color.FromArgb(255, 237, 162, 60),
        Color.FromArgb(255, 104, 210, 206), Color.FromArgb(255, 190, 151, 235),
        Color.FromArgb(255, 239, 143, 180), Color.FromArgb(255, 126, 181, 244)
    ];

    public DotGridBackdrop()
    {
        IsHitTestVisible = false;
        Content = canvas;
        frameTimer = DispatcherQueue.CreateTimer();
        frameTimer.IsRepeating = true;
        frameTimer.Interval = TimeSpan.FromMilliseconds(33);
        frameTimer.Tick += Frame;
        canvas.Draw += DrawField;
        SizeChanged += (_, _) => ClearCache();
        ActualThemeChanged += (_, _) => ClearCache();
        Loaded += (_, _) => SetVisible(visible);
        Unloaded += (_, _) => SetVisible(false);
        uiSettings.AnimationsEnabledChanged += (_, _) =>
            DispatcherQueue.TryEnqueue(() => SetVisible(visible));
        uiSettings.ColorValuesChanged += (_, _) =>
            DispatcherQueue.TryEnqueue(() => { ClearCache(); SetVisible(visible); });
    }

    private void Invalidate() => canvas.Invalidate();

    public void SetVisible(bool value)
    {
        visible = value;
        bool run = value && IsLoaded && uiSettings.AnimationsEnabled && !accessibility.HighContrast;
        field.SetEnabled(run, clock.Elapsed.TotalSeconds);
        if (run != rendering)
        {
            if (run) frameTimer.Start();
            else frameTimer.Stop();
            rendering = run;
        }
        Invalidate();
    }

    public void Receive()
    {
        if (!rendering) return;
        field.Receive(clock.Elapsed.TotalSeconds, ActualWidth, ActualHeight, Excluded);
        Invalidate();
    }

    private void Frame(Microsoft.UI.Dispatching.DispatcherQueueTimer sender, object args)
    {
        field.Tick(clock.Elapsed.TotalSeconds, ActualWidth, ActualHeight, Excluded);
        Invalidate();
    }

    private void ClearCache()
    {
        lattice?.Dispose();
        lattice = null;
        Invalidate();
    }

    private void DrawField(CanvasControl sender, CanvasDrawEventArgs args)
    {
        if (ActualWidth <= 0 || ActualHeight <= 0 || accessibility.HighContrast) return;
        dark = ActualTheme == ElementTheme.Dark;
        if (lattice is null)
        {
            lattice = new CanvasRenderTarget(sender, (float)ActualWidth, (float)ActualHeight, sender.Dpi);
            using var drawing = lattice.CreateDrawingSession();
            drawing.Clear(Colors.Transparent);
            Color baseColor = dark ? Color.FromArgb(80, 104, 210, 206) : Color.FromArgb(50, 26, 132, 142);
            for (double y = 7.5; y < ActualHeight; y += PulseField.Step)
                for (double x = 7.5; x < ActualWidth; x += PulseField.Step)
                    drawing.FillCircle((float)x, (float)y, 1, baseColor);
        }
        args.DrawingSession.DrawImage(lattice);
        var palette = dark ? DarkColors : LightColors;
        double now = clock.Elapsed.TotalSeconds;
        foreach (var pulse in field.Pulses)
        {
            double left = Math.Max(7.5, Math.Ceiling((pulse.Origin.X - Pulse.Reach - 7.5) / 15) * 15 + 7.5);
            double top = Math.Max(7.5, Math.Ceiling((pulse.Origin.Y - Pulse.Reach - 7.5) / 15) * 15 + 7.5);
            for (double y = top; y < Math.Min(ActualHeight, pulse.Origin.Y + Pulse.Reach); y += PulseField.Step)
                for (double x = left; x < Math.Min(ActualWidth, pulse.Origin.X + Pulse.Reach); x += PulseField.Step)
                {
                    double heat = pulse.Heat(new(x, y), now);
                    if (heat < 0.005) continue;
                    Color color = palette[pulse.Color];
                    color.A = (byte)Math.Clamp(heat * 255, 0, 255);
                    args.DrawingSession.FillCircle((float)x, (float)y, (float)(1.3 + heat * 3.2), color);
                }
        }
    }
}
