using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using StreetCryptid.Repeater.Core;
using StreetCryptid.Repeater.Services;
using Windows.ApplicationModel.DataTransfer;
using Microsoft.UI.Windowing;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;
using Windows.UI.ViewManagement;

namespace StreetCryptid.Repeater;

public sealed partial class MainWindow : Window
{
    private readonly string stateDirectory = ServiceLayout.UserStateDirectory;
    private PreferencesStore store = null!;
    private Preferences preferences = new();
    private HostLink? host;
    private HostSnapshot? snapshot;
    private ServiceStatus? service;
    /// <summary>The settings this connection was last asked to apply, so each change is sent once.</summary>
    private HostSettings? requested;
    private bool editing;
    private bool loading = true;
    private bool quitting;
    private bool switching;
    private bool settingsDamaged;
    private bool sessionLocked;
    private TrayIcon? tray;
    private readonly Updates updates = new();
    private readonly Microsoft.UI.Dispatching.DispatcherQueueTimer updateTimer;
    private readonly Microsoft.UI.Dispatching.DispatcherQueueTimer retryTimer;
    private int retryCount;
    private bool retrying;
    private string? renderedPage;
    private string memberRowsKey = "";
    private readonly Storyboard pageTransition = new();
    public bool ShouldStartHidden => tray is not null && Program.Startup &&
        preferences.SetupComplete && preferences.StartInTray;

    public MainWindow()
    {
        InitializeComponent();
        retryTimer = DispatcherQueue.CreateTimer();
        retryTimer.IsRepeating = false;
        retryTimer.Tick += (_, _) => _ = RetryHostAsync();
        Title = "streetCryptid repeater";
        ExtendsContentIntoTitleBar = true;
        SetTitleBar(AppTitleBar);
        AppWindow.Resize(new Windows.Graphics.SizeInt32(1000, 760));
        try { AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "Assets", "repeater.ico")); }
        catch { /* The taskbar falls back to the executable's own icon. */ }
        Root.ActualThemeChanged += (_, _) => UpdateLogo();
        UpdateLogo();
        store = new PreferencesStore(stateDirectory);
        try
        {
            SecureUserDirectory();
            preferences = store.Load();
            // The identity moved to the service, whatever the preferences say: follow it.
            if (File.Exists(Path.Combine(stateDirectory, ServiceLayout.MovedMarker)) && !preferences.UsesService)
            {
                preferences = preferences with { RunAsService = true };
                store.Save(preferences);
            }
        }
        catch
        {
            settingsDamaged = true;
            ShowMessage("Settings could not be read. Restore settings.json before continuing.");
        }
        StartupChoice.IsOn = preferences.SetupComplete
            ? StartupRegistration.IsRegistered() && !StartupRegistration.IsDisabledByWindows()
            : preferences.StartWithWindows;
        TrayChoice.IsOn = preferences.StartInTray;
        CloseChoice.IsOn = preferences.CloseToTray;
        UpdatesChoice.IsOn = preferences.AutoUpdate;
        ServiceChoice.IsOn = preferences.RunAsService ?? !preferences.SetupComplete;
        AwakeChoice.IsOn = preferences.KeepAwake;
        DiagnosticsChoice.IsOn = preferences.Telemetry;
        loading = false;
        editing = !preferences.SetupComplete;
        SaveButton.IsEnabled = !settingsDamaged;
        Render();
        Activated += (_, _) => UpdateAnimation();
        AppWindow.Changed += (_, _) => UpdateAnimation();
        AppWindow.Closing += (sender, e) =>
        {
            if (quitting) return;
            e.Cancel = true;
            if (preferences.SetupComplete && preferences.CloseToTray && tray is not null)
            {
                AppWindow.Hide();
                UpdateAnimation();
            }
            else _ = QuitAsync();
        };
        try
        {
            tray = new TrayIcon(WinRT.Interop.WindowNative.GetWindowHandle(this));
            tray.Open += ShowWindow;
            tray.Settings += () => { ShowWindow(); editing = true; Render(); };
            tray.Update += () => { ShowWindow(); _ = CheckUpdatesAsync(); };
            tray.Quit += () => _ = QuitAsync();
            tray.SessionLocked += locked => { sessionLocked = locked; UpdateAnimation(); };
        }
        catch { ShowMessage("System tray unavailable. Closing will quit."); }
        Program.OpenRequested += OpenRequested;
        Closed += (_, _) => { Program.OpenRequested -= OpenRequested; tray?.Dispose(); };
        Root.Loaded += (_, _) => { UpdateAnimation(); UpdateExclusions(); };
        Island.SizeChanged += (_, _) => UpdateExclusions();
        Field.SizeChanged += (_, _) => UpdateExclusions();
        if (!settingsDamaged) StartHost();
        updateTimer = DispatcherQueue.CreateTimer();
        updateTimer.Interval = TimeSpan.FromHours(6);
        updateTimer.Tick += (_, _) =>
        {
            if (preferences.SetupComplete && preferences.AutoUpdate) _ = CheckUpdatesAsync(false);
        };
        updateTimer.Start();
        if (preferences.SetupComplete && preferences.AutoUpdate) _ = CheckUpdatesAsync(false);
    }

    /// <summary>
    /// The person, SYSTEM and Administrators: an administrator could take ownership anyway, and the
    /// elevated service installer has to read the identity it moves.
    /// </summary>
    private void SecureUserDirectory()
    {
        var directory = Directory.CreateDirectory(stateDirectory);
        using var user = WindowsIdentity.GetCurrent();
        var access = new DirectorySecurity();
        access.SetAccessRuleProtection(true, false);
        foreach (var sid in new[]
                 {
                     user.User!, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                     new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
                 })
            access.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                PropagationFlags.None, AccessControlType.Allow));
        directory.SetAccessControl(access);
    }

    private void UpdateLogo()
    {
        string name = Root.ActualTheme == ElementTheme.Dark ? "mothman-logo-dark.svg" : "mothman-logo.svg";
        LogoSource.UriSource = new Uri($"ms-appx:///Assets/{name}");
    }

    private void UpdateExclusions()
    {
        if (!Island.IsLoaded) return;
        Island.Width = Math.Max(0, Math.Min(620, Field.ActualWidth - 80));
        var point = Island.TransformToVisual(Field).TransformPoint(new Windows.Foundation.Point());
        Field.Excluded = [new FieldRect(point.X, point.Y, Island.ActualWidth, Island.ActualHeight)];
    }

    private void UpdateAnimation()
    {
        bool minimized = AppWindow.Presenter is OverlappedPresenter p && p.State == OverlappedPresenterState.Minimized;
        Field.SetVisible(AppWindow.IsVisible && !minimized && !quitting && !sessionLocked);
    }

    private void OpenRequested() => DispatcherQueue.TryEnqueue(ShowWindow);

    private void ShowWindow()
    {
        AppWindow.Show();
        if (AppWindow.Presenter is OverlappedPresenter p && p.State == OverlappedPresenterState.Minimized)
            p.Restore();
        Activate();
        UpdateAnimation();
    }

    private void StartHost()
    {
        if (quitting) return;
        StatusText.Text = "STARTING";
        RetryButton.Visibility = Visibility.Collapsed;
        service = null;
        requested = null;
        if (preferences.UsesService && !ServiceControl.IsInstalled())
        {
            StatusText.Text = "STOPPED";
            ShowMessage("The repeater service is not installed. Open Settings and save to install it again, " +
                        "or turn off \"Run as a Windows service\" to run it here.");
            return;
        }
        HostLink link = preferences.UsesService ? new ServiceLink() : new ChildLink(stateDirectory);
        host = link;
        link.Snapshot += value => DispatcherQueue.TryEnqueue(() =>
        {
            if (host != link || quitting) return;
            snapshot = value;
            retryCount = 0;
            StatusText.Text = value.Claimed ? "RUNNING" : "AWAITING CLAIM";
            Reconcile(link, value);
            Render();
        });
        link.Service += value => DispatcherQueue.TryEnqueue(() =>
        {
            if (host != link || quitting) return;
            service = value;
            if (value.Host != "running")
            {
                snapshot = null;
                StatusText.Text = value.Host.ToUpperInvariant();
            }
            Render();
        });
        link.Arrival += () => DispatcherQueue.TryEnqueue(() =>
        {
            if (host == link && !quitting) Field.Receive();
        });
        link.Failed += (message, incompatible) => DispatcherQueue.TryEnqueue(() =>
        {
            if (host != link || quitting) return;
            StatusText.Text = "STOPPED";
            snapshot = null;
            Render();
            ShowMessage(message);
            UpdateServiceButton.Visibility = incompatible ? Visibility.Visible : Visibility.Collapsed;
            if (incompatible) return;
            RetryButton.Visibility = Visibility.Visible;
            if (retryCount < 3)
            {
                retryTimer.Interval = TimeSpan.FromSeconds(2 * Math.Pow(3, retryCount++));
                retryTimer.Start();
            }
        });
        link.Start();
    }

    /// <summary>
    /// Bring the host's settings into line with this person's choices — after a mode switch moved
    /// the identity, after a damaged settings file, or on a host that has never been told.
    /// </summary>
    private void Reconcile(HostLink link, HostSnapshot value)
    {
        if (!preferences.SetupComplete || value.Settings is null || switching) return;
        var wanted = preferences.HostSettings with { Telemetry = preferences.Telemetry && value.TelemetryAvailable };
        if (value.Settings == wanted || requested == wanted) return;
        requested = wanted;
        _ = ApplyAsync(link, wanted);
    }

    private async Task ApplyAsync(HostLink link, HostSettings wanted)
    {
        if (await link.ApplySettingsAsync(wanted) || host != link) return;
        requested = null;
        ShowMessage("The repeater did not confirm its new settings. They will be retried.");
    }

    private void Render()
    {
        string page = editing ? "settings" : snapshot?.Claimed == true ? "running" : "claim";
        bool changedPage = renderedPage is not null && renderedPage != page;
        renderedPage = page;
        SettingsGlyph.Glyph = editing && preferences.SetupComplete ? "" : "";
        string navigationLabel = editing && preferences.SetupComplete ? "Back to repeater" : "Settings";
        AutomationProperties.SetName(SettingsButton, navigationLabel);
        ToolTipService.SetToolTip(SettingsButton, navigationLabel);
        SettingsHeading.Text = preferences.SetupComplete ? "Settings" : "Setup";
        SetupPanel.Visibility = editing ? Visibility.Visible : Visibility.Collapsed;
        bool claimed = snapshot?.Claimed == true;
        ClaimPanel.Visibility = !editing && !claimed && snapshot?.ClaimUrl is not null ? Visibility.Visible : Visibility.Collapsed;
        RunningPanel.Visibility = !editing && claimed ? Visibility.Visible : Visibility.Collapsed;
        Qr.SetLink(!editing && !claimed ? snapshot?.ClaimUrl : null);
        SaveButton.Content = preferences.SetupComplete ? "SAVE" : "CONTINUE";
        SaveButton.IsEnabled = !settingsDamaged && !switching;
        StartupHelp.Visibility = TrayHelp.Visibility = UpdateHelp.Visibility = ServiceHelp.Visibility =
            AwakeHelp.Visibility = preferences.SetupComplete ? Visibility.Collapsed : Visibility.Visible;
        bool diagnostics = snapshot?.TelemetryAvailable ?? true;
        DiagnosticsChoice.Visibility = DiagnosticsHelp.Visibility =
            diagnostics ? Visibility.Visible : Visibility.Collapsed;
        UpdateButton.Visibility = editing && preferences.SetupComplete ? Visibility.Visible : Visibility.Collapsed;
        TrayChoice.IsEnabled = StartupChoice.IsOn;
        VersionText.Text = $"Version {ServiceControl.AppVersion}" +
            (service is { } s ? $" · service {s.Version}" : "") +
            (snapshot?.EndpointId is { } id ? $"\nRepeater {id[..Math.Min(12, id.Length)]}" : "");
        bool serviceBehind = service is { } running && running.Version != ServiceControl.AppVersion;
        if (serviceBehind) UpdateServiceButton.Visibility = Visibility.Visible;
        if (changedPage) AnimatePage();
        if (snapshot is not { Claimed: true } value) return;
        int count = value.Members.Length;
        MemberCount.Text = $"Carrying for {count} {(count == 1 ? "person" : "people")}";
        ContentStatus.Text = $"{value.Tracked - value.Missing:N0} encrypted items ready to forward" +
            (value.Missing > 0 ? $" · {value.Missing:N0} waiting for data" : "") +
            $"\n{value.Received:N0} location updates received since the repeater started";
        ReceivedText.Text = FormatBytes(value.BytesReceived);
        SentText.Text = FormatBytes(value.BytesSent);
        ConnectionText.Text = $"{value.Connections:N0} active connections · {value.ConnectionsOpened:N0} opened since it started";
        HostText.Text = (value.Mode == "service"
                ? "Runs as a Windows service, whether or not anyone is signed in."
                : "Runs while this app is open.") +
            " Keeps what it carries in memory only." +
            (value.Settings?.KeepAwake == true ? " Keeps the PC awake on mains power." : "");
        PolicyStatus.Text = $"Membership: {value.Policy ?? "Unknown"}. To stop carrying someone, " +
            "remove them from this repeater on your phone (Settings → Repeaters).";
        string rowsKey = string.Join(",", value.Members);
        if (memberRowsKey != rowsKey)
        {
            memberRowsKey = rowsKey;
            Members.Children.Clear();
            foreach (string member in value.Members)
            {
                var identity = new StackPanel { Spacing = 2 };
                identity.Children.Add(new TextBlock
                {
                    Text = member[..Math.Min(12, member.Length)],
                    FontFamily = new FontFamily("ms-appx:///Assets/Plex.ttf#IBM Plex Mono"),
                    FontSize = 13
                });
                identity.Children.Add(new TextBlock
                {
                    Text = member == value.Owner ? "Owner · carried" : "Carried",
                    FontSize = 12
                });
                ToolTipService.SetToolTip(identity, member);
                AutomationProperties.SetName(identity, $"Carried: {member[..Math.Min(12, member.Length)]}");
                Members.Children.Add(identity);
            }
        }
    }

    private static string FormatBytes(ulong bytes) => bytes switch
    {
        < 1024 => $"{bytes:N0} B",
        < 1024 * 1024 => $"{bytes / 1024d:N1} KiB",
        < 1024 * 1024 * 1024 => $"{bytes / (1024d * 1024):N1} MiB",
        _ => $"{bytes / (1024d * 1024 * 1024):N2} GiB"
    };

    private void AnimatePage()
    {
        pageTransition.Stop();
        PageContent.Opacity = 1;
        PageOffset.X = 0;
        if (!new UISettings().AnimationsEnabled) return;
        pageTransition.Children.Clear();
        var easing = new ExponentialEase { EasingMode = EasingMode.EaseOut, Exponent = 5 };
        var slide = new DoubleAnimation
        {
            From = editing ? 18 : -18,
            To = 0,
            Duration = new Duration(TimeSpan.FromMilliseconds(220)),
            EasingFunction = easing
        };
        Storyboard.SetTarget(slide, PageOffset);
        Storyboard.SetTargetProperty(slide, "X");
        var fade = new DoubleAnimation { From = .45, To = 1, Duration = slide.Duration };
        Storyboard.SetTarget(fade, PageContent);
        Storyboard.SetTargetProperty(fade, "Opacity");
        pageTransition.Children.Add(slide);
        pageTransition.Children.Add(fade);
        pageTransition.Begin();
    }

    private Preferences Choices(bool complete) => preferences with
    {
        SetupComplete = complete,
        StartWithWindows = StartupChoice.IsOn,
        StartInTray = TrayChoice.IsOn,
        CloseToTray = CloseChoice.IsOn,
        AutoUpdate = UpdatesChoice.IsOn,
        RunAsService = ServiceChoice.IsOn,
        KeepAwake = AwakeChoice.IsOn,
        Telemetry = DiagnosticsChoice.IsOn,
    };

    private void SaveDraft(object sender, RoutedEventArgs args)
    {
        if (loading || settingsDamaged) return;
        TrayChoice.IsEnabled = StartupChoice.IsOn;
        if (preferences.SetupComplete) return;
        try { store.Save(Choices(false) with { RunAsService = null }); }
        catch { ShowMessage("Settings could not be saved."); }
    }

    private async void SaveClicked(object sender, RoutedEventArgs args)
    {
        if (switching) return;
        try
        {
            var chosen = Choices(true);
            // What actually holds the identity decides the current mode, not the last preference.
            bool underService = File.Exists(Path.Combine(stateDirectory, ServiceLayout.MovedMarker)) ||
                                (preferences.UsesService && ServiceControl.IsInstalled());
            bool modeChanges = chosen.UsesService != underService ||
                               (chosen.UsesService && !ServiceControl.IsInstalled());
            if (modeChanges && !await SwitchModeAsync(chosen.UsesService))
                chosen = chosen with { RunAsService = preferences.UsesService };
            StartupRegistration.Apply(chosen.StartWithWindows, () => store.Save(chosen));
            preferences = chosen;
            ServiceChoice.IsOn = preferences.UsesService;
            editing = false;
            if (!modeChanges) MessageText.Visibility = Visibility.Collapsed;
            requested = null;
            if (host is not null && snapshot is not null) Reconcile(host, snapshot);
            Render();
            if (StartupChoice.IsOn && StartupRegistration.IsDisabledByWindows())
                ShowMessage("Opening with Windows is disabled in Windows Settings.");
            if (preferences.AutoUpdate) _ = CheckUpdatesAsync(false);
        }
        catch (InvalidOperationException error) { ShowMessage(error.Message); }
        catch { ShowMessage("Settings could not be saved."); }
    }

    /// <summary>
    /// Move the repeater under the service or back out of it. The running host has to stop first
    /// (it holds the identity); whatever the outcome, a host is started again in the mode that
    /// actually holds the identity afterwards.
    /// </summary>
    private async Task<bool> SwitchModeAsync(bool toService)
    {
        switching = true;
        Render();
        StatusText.Text = toService ? "INSTALLING SERVICE" : "REMOVING SERVICE";
        ShowMessage(toService
            ? "Moving this repeater into a Windows service. Approve the administrator prompt to continue."
            : "Moving this repeater out of the Windows service. Approve the administrator prompt to continue.");
        try
        {
            if (host is not null) await host.DisposeAsync();
            host = null;
            snapshot = null;
            var result = toService
                ? await ServiceControl.InstallAsync(stateDirectory)
                : await ServiceControl.UninstallAsync(stateDirectory);
            bool ok = result == ServiceVerbResult.Ok;
            ShowMessage(ok
                ? toService
                    ? "The repeater now runs as a Windows service. Closing this app no longer stops it."
                    : "The repeater now runs only while this app is open."
                : ServiceControl.Describe(result));
            preferences = preferences with { RunAsService = ok ? toService : preferences.UsesService };
            return ok;
        }
        finally
        {
            switching = false;
            StartHost();
            Render();
        }
    }

    private async void UpdateServiceClicked(object sender, RoutedEventArgs args)
    {
        if (switching) return;
        switching = true;
        UpdateServiceButton.IsEnabled = false;
        ShowMessage("Updating the repeater service. Approve the administrator prompt to continue.");
        try
        {
            if (host is not null) await host.DisposeAsync();
            host = null;
            var result = await ServiceControl.InstallAsync(stateDirectory);
            ShowMessage(result == ServiceVerbResult.Ok
                ? "The repeater service is up to date."
                : ServiceControl.Describe(result));
            if (result == ServiceVerbResult.Ok) UpdateServiceButton.Visibility = Visibility.Collapsed;
        }
        finally
        {
            switching = false;
            UpdateServiceButton.IsEnabled = true;
            StartHost();
            Render();
        }
    }

    private void SettingsClicked(object sender, RoutedEventArgs args)
    {
        editing = !editing || !preferences.SetupComplete;
        Render();
    }

    private void CopyClicked(object sender, RoutedEventArgs args)
    {
        if (snapshot?.ClaimUrl is not { } link) return;
        try
        {
            var data = new DataPackage();
            data.SetText(link);
            Clipboard.SetContent(data);
            ShowMessage("Claim link copied.");
        }
        catch { ShowMessage("Clipboard unavailable."); }
    }

    private async void RetryClicked(object sender, RoutedEventArgs args)
    {
        retryCount = 0;
        retryTimer.Stop();
        await RetryHostAsync();
    }

    private async Task RetryHostAsync()
    {
        if (retrying || quitting || switching) return;
        retrying = true;
        RetryButton.IsEnabled = false;
        try
        {
            if (host is not null) await host.DisposeAsync();
            if (quitting) return;
            MessageText.Visibility = Visibility.Collapsed;
            StartHost();
        }
        finally
        {
            RetryButton.IsEnabled = true;
            retrying = false;
        }
    }

    private async void UpdateClicked(object sender, RoutedEventArgs args) => await CheckUpdatesAsync();

    private async Task CheckUpdatesAsync(bool showResult = true)
    {
        var result = await updates.CheckAsync();
        if (quitting) return;
        if (showResult || updates.CanRestart) ShowMessage(result);
        RestartButton.Visibility = updates.CanRestart ? Visibility.Visible : Visibility.Collapsed;
    }

    private async void RestartClicked(object sender, RoutedEventArgs args)
    {
        if (!updates.CanRestart || quitting) return;
        quitting = true;
        retryTimer.Stop();
        updateTimer.Stop();
        UpdateAnimation();
        if (host is not null) await host.DisposeAsync();
        tray?.Dispose();
        tray = null;
        try { updates.Restart(); }
        catch
        {
            quitting = false;
            updateTimer.Start();
            ShowWindow();
            StatusText.Text = "STOPPED";
            snapshot = null;
            Render();
            ShowMessage("Update could not restart. Close and reopen the repeater.");
            RetryButton.Visibility = Visibility.Visible;
        }
    }

    private void ShowMessage(string text)
    {
        MessageText.Text = text;
        MessageText.Visibility = Visibility.Visible;
    }

    public async Task QuitAsync()
    {
        if (quitting) return;
        quitting = true;
        retryTimer.Stop();
        updateTimer.Stop();
        UpdateAnimation();
        // Under the service this only closes the app; the repeater keeps running.
        if (host is not null) await host.DisposeAsync();
        tray?.Dispose();
        Close();
    }
}
