using Microsoft.UI.Xaml;

namespace StreetCryptid.Repeater;

public partial class App : Application
{
    private MainWindow? window;

    public App() => InitializeComponent();

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        window = new MainWindow();
        if (!window.ShouldStartHidden) window.Activate();
    }
}
