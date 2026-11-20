using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using StreetCryptid.Repeater.Core;

namespace StreetCryptid.Repeater;

public sealed partial class MainWindow
{
    private sealed record RelayEditor(TextBox Url, PasswordBox Key, CheckBox Clear);
    private readonly List<RelayEditor> relayEditors = [];
    private bool networkLoaded;

    private void RenderNetwork(HostSnapshot? value, bool shown)
    {
        NetworkPanel.Visibility = shown && value?.Network is not null ? Visibility.Visible : Visibility.Collapsed;
        if (!shown) { networkLoaded = false; return; }
        if (value?.Network is not { } network) return;
        NetworkRestart.Text = network.RestartRequired
            ? "Restart required. Quit and reopen a per-user repeater; for service mode restart StreetCryptidRepeater in Windows Services (administrator). Identity and grants are kept."
            : "Connection changes apply after restarting the repeater (or its Windows service).";
        if (networkLoaded) return;
        networkLoaded = true;
        relayEditors.Clear();
        NetworkRelays.Children.Clear();
        foreach (var relay in network.Relays) AddRelay(relay.Url, relay.HasAuthToken);
        NetworkEndpoint.Text = network.TelemetryEndpoint;
    }

    private void AddRelay(string url, bool hasKey)
    {
        if (relayEditors.Count >= 8) return;
        var address = new TextBox { Header = "Relay URL", PlaceholderText = "https://relay.example", Text = url };
        var key = new PasswordBox { Header = hasKey ? "Key saved; leave blank to keep" : "Optional relay key" };
        var clear = new CheckBox { Content = "Clear saved key" };
        var remove = new Button { Content = "REMOVE RELAY" };
        var row = new StackPanel { Spacing = 4 };
        row.Children.Add(address);
        row.Children.Add(key);
        row.Children.Add(clear);
        row.Children.Add(remove);
        var editor = new RelayEditor(address, key, clear);
        remove.Click += (_, _) => { relayEditors.Remove(editor); NetworkRelays.Children.Remove(row); };
        relayEditors.Add(editor);
        NetworkRelays.Children.Add(row);
    }

    private void AddRelayClicked(object sender, RoutedEventArgs args) => AddRelay("", false);

    private async void SaveNetworkClicked(object sender, RoutedEventArgs args)
    {
        if (host is null || snapshot?.Network is null || switching || ServiceBehind) return;
        NetworkSave.IsEnabled = false;
        try
        {
            var network = new NetworkConfig(relayEditors.Select(row => new RelayConfig(
                row.Url.Text.Trim(), row.Clear.IsChecked == true ? "" :
                    string.IsNullOrEmpty(row.Key.Password) ? null : row.Key.Password)).ToArray(),
                NetworkEndpoint.Text.Trim());
            if (!await host.ApplyNetworkAsync(network)) throw new InvalidOperationException();
            foreach (var row in relayEditors)
            {
                row.Key.Password = "";
                row.Clear.IsChecked = false;
            }
            NetworkRestart.Text = "Saved. Restart the repeater (or its Windows service) to apply.";
        }
        catch
        {
            await NoticeAsync("Network settings not saved",
                "Use unique HTTPS relay origins and a valid collector URL (HTTP only on loopback), with at most eight relays.");
        }
        finally { NetworkSave.IsEnabled = true; }
    }
}
