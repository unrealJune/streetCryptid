using Microsoft.Graphics.Canvas.UI.Xaml;
using Microsoft.UI;
using Microsoft.UI.Xaml.Controls;
using QRCoder;

namespace StreetCryptid.Repeater.Controls;

public sealed class ClaimQr : UserControl
{
    private readonly CanvasControl canvas = new();
    private QRCodeData? code;
    private string? link;

    public ClaimQr()
    {
        Width = Height = 300;
        Content = canvas;
        canvas.ClearColor = Colors.White;
        IsHitTestVisible = false;
        canvas.Draw += (_, args) =>
        {
            if (code is null) return;
            float step = (float)ActualWidth / code.ModuleMatrix.Count;
            for (int y = 0; y < code.ModuleMatrix.Count; y++)
                for (int x = 0; x < code.ModuleMatrix.Count; x++)
                    if (code.ModuleMatrix[y][x])
                    {
                        bool finder = (x < 12 && y < 12) ||
                            (x >= code.ModuleMatrix.Count - 12 && y < 12) ||
                            (x < 12 && y >= code.ModuleMatrix.Count - 12);
                        if (finder) args.DrawingSession.FillRectangle(x * step, y * step, step, step, Colors.Black);
                        else args.DrawingSession.FillRoundedRectangle(x * step, y * step, step, step,
                            step * 0.18f, step * 0.18f, Colors.Black);
                    }
        };
        Unloaded += (_, _) => { code?.Dispose(); code = null; link = null; };
    }

    public void SetLink(string? value)
    {
        if (link == value) return;
        link = value;
        code?.Dispose();
        code = value is null ? null : QRCodeGenerator.GenerateQrCode(value, QRCodeGenerator.ECCLevel.Q);
        canvas.Invalidate();
    }
}
