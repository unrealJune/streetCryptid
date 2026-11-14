using Microsoft.UI;
using Microsoft.UI.Input;
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
    /// <summary>What is wrong right now; cleared as soon as it is not. Never a log of past actions.</summary>
    private string? problem;
    private bool problemRetryable;
    /// <summary>The service answered in a protocol this app does not speak: it is older than the app.</summary>
    private bool serviceIncompatible;
    /// <summary>Restarted by an update: bring the service up to this version as soon as it answers.</summary>
    private bool finishUpdate = Program.FinishingUpdate;
    private bool checkingUpdates;
    private UpdateCheck? lastCheck;
    /// <summary>A name saved while the service was too old to take it; sent once it has been updated.</summary>
    private string? pendingName;
    private bool dialogOpen;
    /// <summary>The card is showing the update's steps.</summary>
    private bool updateView = Program.FinishingUpdate;
    /// <summary>This process is the new version an update restarted into.</summary>
    private readonly bool restartedForUpdate = Program.FinishingUpdate;
    private bool updatingService;
    private bool restarting;
    private string? serviceUpdateFailure;
    private bool updateCloseArmed;
    public bool ShouldStartHidden => tray is not null && Program.Startup &&
        preferences.SetupComplete && preferences.StartInTray;

    /// <summary>
    /// The service runs its own copy of the app's binaries, replaced only by an elevated install.
    /// To the person it is one app, so a service behind the app is simply an update not yet done.
    /// </summary>
    private bool ServiceBehind => preferences.UsesService &&
        (serviceIncompatible || service is { } s && s.Version != ServiceControl.AppVersion);

    private bool UpdatePending => updates.CanRestart || ServiceBehind;

    public MainWindow()
    {
        InitializeComponent();
        retryTimer = DispatcherQueue.CreateTimer();
        retryTimer.IsRepeating = false;
        retryTimer.Tick += (_, _) => _ = RetryHostAsync();
        Title = "streetCryptid repeater";
        ExtendsContentIntoTitleBar = true;
        AppWindow.TitleBar.PreferredHeightOption = TitleBarHeightOption.Tall;
        SetTitleBar(AppTitleBar);
        AppWindow.Resize(new Windows.Graphics.SizeInt32(1000, 760));
        try { AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "Assets", "repeater.ico")); }
        catch { /* The taskbar falls back to the executable's own icon. */ }
        Root.ActualThemeChanged += (_, _) => UpdateTheme();
        UpdateTheme();
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
            SetProblem("Settings could not be read. Restore settings.json before continuing.");
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
        Render();
        Activated += (_, _) => UpdateAnimation();
        AppWindow.Changed += (_, _) => { UpdateAnimation(); UpdateTitleBar(); };
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
            tray.Update += () =>
            {
                ShowWindow();
                _ = UpdatePending ? RunUpdateAsync() : CheckUpdatesAsync();
            };
            tray.Quit += () => _ = QuitAsync();
            tray.SessionLocked += locked => { sessionLocked = locked; UpdateAnimation(); };
        }
        catch { /* No tray: closing quits. */ }
        Program.OpenRequested += OpenRequested;
        Closed += (_, _) => { Program.OpenRequested -= OpenRequested; tray?.Dispose(); };
        Root.Loaded += (_, _) =>
        {
            UpdateAnimation();
            UpdateExclusions();
            UpdateTitleBar();
            Root.XamlRoot.Changed += (_, _) => UpdateTitleBar();
        };
        Island.SizeChanged += (_, _) => UpdateExclusions();
        Fit.SizeChanged += (_, _) => UpdateExclusions();
        Field.SizeChanged += (_, _) => UpdateExclusions();
        AppTitleBar.SizeChanged += (_, _) => UpdateTitleBar();
        SettingsButton.SizeChanged += (_, _) => UpdateTitleBar();
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

    private void UpdateTheme()
    {
        bool dark = Root.ActualTheme == ElementTheme.Dark;
        LogoSource.UriSource = new Uri($"ms-appx:///Assets/{(dark ? "mothman-logo-dark.svg" : "mothman-logo.svg")}");
        // The caption buttons are drawn by the system over our title bar; match the theme's ink.
        var ink = dark ? Windows.UI.Color.FromArgb(255, 0xDC, 0xEB, 0xF0) : Windows.UI.Color.FromArgb(255, 0x15, 0x26, 0x33);
        var bar = AppWindow.TitleBar;
        bar.ButtonBackgroundColor = Colors.Transparent;
        bar.ButtonInactiveBackgroundColor = Colors.Transparent;
        bar.ButtonForegroundColor = ink;
        bar.ButtonHoverForegroundColor = ink;
        bar.ButtonHoverBackgroundColor = Windows.UI.Color.FromArgb(0x24, ink.R, ink.G, ink.B);
        bar.ButtonPressedForegroundColor = ink;
        bar.ButtonPressedBackgroundColor = Windows.UI.Color.FromArgb(0x38, ink.R, ink.G, ink.B);
    }

    /// <summary>
    /// Keep the status and Settings flush against the caption buttons, and let clicks reach the
    /// Settings button: the rest of the bar drags the window.
    /// </summary>
    private void UpdateTitleBar()
    {
        if (AppTitleBar.XamlRoot is not { } root || !SettingsButton.IsLoaded) return;
        double scale = root.RasterizationScale;
        CaptionColumn.Width = new GridLength(AppWindow.TitleBar.RightInset / scale);
        var bounds = SettingsButton.TransformToVisual(null).TransformBounds(
            new Windows.Foundation.Rect(0, 0, SettingsButton.ActualWidth, SettingsButton.ActualHeight));
        var region = new Windows.Graphics.RectInt32(
            (int)Math.Round(bounds.X * scale), (int)Math.Round(bounds.Y * scale),
            (int)Math.Round(bounds.Width * scale), (int)Math.Round(bounds.Height * scale));
        InputNonClientPointerSource.GetForWindowId(AppWindow.Id)
            .SetRegionRects(NonClientRegionKind.Passthrough, [region]);
    }

    private void UpdateExclusions()
    {
        if (!Island.IsLoaded) return;
        // The card is scaled to fit, so its footprint on the field is its transformed bounds.
        var bounds = Island.TransformToVisual(Field).TransformBounds(
            new Windows.Foundation.Rect(0, 0, Island.ActualWidth, Island.ActualHeight));
        Field.Excluded = [new FieldRect(bounds.X, bounds.Y, bounds.Width, bounds.Height)];
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

    private void SetProblem(string? text, bool retryable = false)
    {
        problem = text;
        problemRetryable = retryable && text is not null;
        if (renderedPage is not null) Render();
    }

    private void StartHost()
    {
        if (quitting) return;
        StatusText.Text = "STARTING";
        service = null;
        requested = null;
        if (preferences.UsesService && !ServiceControl.IsInstalled())
        {
            StatusText.Text = "STOPPED";
            SetProblem("The repeater service is not installed. Save Settings to install it again, " +
                       "or turn off \"Run as a Windows service\".");
            return;
        }
        SetProblem(null);
        HostLink link = preferences.UsesService ? new ServiceLink() : new ChildLink(stateDirectory);
        host = link;
        link.Snapshot += value => DispatcherQueue.TryEnqueue(() =>
        {
            if (host != link || quitting) return;
            snapshot = value;
            retryCount = 0;
            problem = null;
            StatusText.Text = value.Claimed ? "RUNNING" : "AWAITING CLAIM";
            Reconcile(link, value);
            if (pendingName is { } name && !ServiceBehind)
            {
                pendingName = null;
                _ = SendNameAsync(link, name);
            }
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
            FinishUpdateIfDue();
        });
        link.Arrival += () => DispatcherQueue.TryEnqueue(() =>
        {
            if (host == link && !quitting) Field.Receive();
        });
        link.Failed += (message, incompatible) => DispatcherQueue.TryEnqueue(() =>
        {
            if (host != link || quitting) return;
            StatusText.Text = incompatible ? "UPDATE NEEDED" : "STOPPED";
            snapshot = null;
            serviceIncompatible |= incompatible;
            SetProblem(message, !incompatible);
            if (incompatible)
            {
                FinishUpdateIfDue();
                return;
            }
            if (retryCount < 3)
            {
                retryTimer.Interval = TimeSpan.FromSeconds(2 * Math.Pow(3, retryCount++));
                retryTimer.Start();
            }
        });
        link.Start();
    }

    /// <summary>
    /// The second half of an update the person already asked for: the app restarted on its new
    /// version, and the service's copy follows at once (one administrator prompt) rather than
    /// waiting for someone to notice it is behind.
    /// </summary>
    private void FinishUpdateIfDue()
    {
        if (!finishUpdate || !ServiceBehind || switching || quitting) return;
        finishUpdate = false;
        _ = UpdateServiceAsync();
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
        // Unconfirmed settings are asked for again on the next snapshot.
        if (!await link.ApplySettingsAsync(wanted) && host == link) requested = null;
    }

    /// <summary>The name the host last reported, so a snapshot only rewrites the box when it changed.</summary>
    private string? renderedName;

    /// <summary>
    /// The name box in Settings: what this machine is called in the app. The name is signed into
    /// the cert the machine gives its owner's phone, so it reaches the app at a claim, or after a
    /// rename when the owner next opens Repeaters on the phone. Never rewritten while someone is
    /// typing in it.
    /// </summary>
    private void RenderName(HostSnapshot? value, bool shown)
    {
        NameBox.Visibility = shown && value is not null ? Visibility.Visible : Visibility.Collapsed;
        if (value is null) return;
        if (value.Name != renderedName && NameBox.FocusState == FocusState.Unfocused)
        {
            renderedName = value.Name;
            NameBox.Text = value.Name ?? "";
        }
    }

    private static string NormalizeName(string text) =>
        string.Join(' ', text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)
            .Select(word => new string(word.Where(c => !char.IsControl(c)).ToArray()))
            .Where(word => word.Length > 0));

    /// <summary>The name to save, or null when the box is hidden or says what the repeater already has.</summary>
    private string? NameChange()
    {
        if (NameBox.Visibility != Visibility.Visible || snapshot is null) return null;
        string name = NormalizeName(NameBox.Text);
        if (name.Length > HostProtocol.MaxNameLength) name = name[..HostProtocol.MaxNameLength].TrimEnd();
        return name == (snapshot.Name ?? "") ? null : name;
    }

    private void NameKeyDown(object sender, Microsoft.UI.Xaml.Input.KeyRoutedEventArgs args)
    {
        if (args.Key != Windows.System.VirtualKey.Enter) return;
        args.Handled = true;
        SaveClicked(sender, new RoutedEventArgs());
    }

    private async Task SaveNameAsync(string name)
    {
        // A service older than the app drops a connection that sends it a command it does not
        // know, which reads as the repeater failing. Finish the update first, then send it.
        if (ServiceBehind)
        {
            if (!await ConfirmUpdateAsync("This repeater needs to finish updating before it can be renamed.")) return;
            pendingName = name;
            await UpdateServiceAsync();
            return;
        }
        if (host is { } link) await SendNameAsync(link, name);
    }

    private async Task SendNameAsync(HostLink link, string name)
    {
        if (await link.SetNameAsync(name))
        {
            renderedName = name.Length == 0 ? null : name;
            NameBox.Text = name;
        }
        else if (host == link) await NoticeAsync("Name not saved", "The repeater did not save the name. Try again.");
    }

    private void Render()
    {
        if (updateView && !preferences.SetupComplete) updateView = false;
        string page = updateView ? "update" : editing ? "settings" : snapshot?.Claimed == true ? "running" : "claim";
        bool changedPage = renderedPage is not null && renderedPage != page;
        renderedPage = page;
        bool settingsOpen = page == "settings" && preferences.SetupComplete;
        bool back = settingsOpen || updateView;
        SettingsGlyph.Glyph = back ? "" : "";
        SettingsButton.IsEnabled = !(updateView && (updatingService || restarting));
        string navigationLabel = back ? "Back to repeater" : "Settings";
        AutomationProperties.SetName(SettingsButton, navigationLabel);
        ToolTipService.SetToolTip(SettingsButton, navigationLabel);
        SettingsHeading.Text = preferences.SetupComplete ? "Settings" : "Setup";
        SetupPanel.Visibility = page == "settings" ? Visibility.Visible : Visibility.Collapsed;
        bool claimed = snapshot?.Claimed == true;
        ClaimPanel.Visibility = page == "claim" && snapshot?.ClaimUrl is not null ? Visibility.Visible : Visibility.Collapsed;
        RunningPanel.Visibility = page == "running" ? Visibility.Visible : Visibility.Collapsed;
        UpdatePanel.Visibility = page == "update" ? Visibility.Visible : Visibility.Collapsed;
        RenderName(snapshot, settingsOpen);
        Qr.SetLink(page == "claim" ? snapshot?.ClaimUrl : null);
        SaveButton.Content = preferences.SetupComplete ? "SAVE" : "CONTINUE";
        SaveButton.IsEnabled = !settingsDamaged && !switching;
        DiagnosticsChoice.Visibility = snapshot?.TelemetryAvailable ?? true ? Visibility.Visible : Visibility.Collapsed;
        TrayChoice.IsEnabled = StartupChoice.IsOn;
        ReleaseButton.Visibility = settingsOpen && claimed ? Visibility.Visible : Visibility.Collapsed;
        ReleaseButton.IsEnabled = !switching;
        VersionText.Text = $"Version {ServiceControl.AppVersion}" +
            (snapshot?.EndpointId is { } id ? $" · repeater {id[..Math.Min(12, id.Length)]}" : "");
        RenderUpdate(settingsOpen);
        RenderUpdateSteps();
        ProblemPanel.Visibility = problem is null ? Visibility.Collapsed : Visibility.Visible;
        ProblemText.Text = problem ?? "";
        RetryButton.Visibility = problemRetryable ? Visibility.Visible : Visibility.Collapsed;
        if (changedPage) AnimatePage();
        if (snapshot is not { Claimed: true } value) return;
        int count = value.Members.Length;
        MemberCount.Text = $"Carrying for {count} {(count == 1 ? "person" : "people")}";
        ContentStatus.Text = $"{value.Tracked - value.Missing:N0} encrypted items ready to forward" +
            (value.Missing > 0 ? $" · {value.Missing:N0} waiting for data" : "") +
            $"\n{value.Received:N0} location updates received";
        ReceivedText.Text = FormatBytes(value.BytesReceived);
        SentText.Text = FormatBytes(value.BytesSent);
        ConnectionText.Text = $"{value.Connections:N0} connections · {value.ConnectionsOpened:N0} opened";
        string rowsKey = value.Owner + "|" + string.Join(",", value.Members);
        if (memberRowsKey != rowsKey)
        {
            memberRowsKey = rowsKey;
            Members.Children.Clear();
            foreach (string member in value.Members)
            {
                string shortId = member[..Math.Min(12, member.Length)];
                bool owner = member == value.Owner;
                var row = new TextBlock
                {
                    FontFamily = new FontFamily("ms-appx:///Assets/Plex.ttf#IBM Plex Mono"),
                    FontSize = 13
                };
                row.Inlines.Add(new Microsoft.UI.Xaml.Documents.Run { Text = shortId });
                if (owner)
                    row.Inlines.Add(new Microsoft.UI.Xaml.Documents.Run { Text = "  OWNER" });
                ToolTipService.SetToolTip(row, member);
                AutomationProperties.SetName(row, owner ? $"Owner: {shortId}" : shortId);
                Members.Children.Add(row);
            }
        }
    }

    /// <summary>
    /// One update, whatever it involves: the app's own (restart into the new version) and the
    /// service's copy (an administrator prompt) are a single button and a single state.
    /// </summary>
    private void RenderUpdate(bool settingsOpen)
    {
        string label = UpdatePending ? "UPDATE"
            : checkingUpdates ? "CHECKING"
            : lastCheck switch
            {
                UpdateCheck.UpToDate => "UP TO DATE",
                UpdateCheck.Failed => "CHECK FAILED",
                _ => "CHECK FOR UPDATES",
            };
        bool enabled = !switching && !quitting && (UpdatePending || !checkingUpdates);
        UpdateButton.Content = SettingsUpdateButton.Content = label;
        UpdateButton.IsEnabled = SettingsUpdateButton.IsEnabled = enabled;
        UpdateButton.Visibility = !editing && !updateView && UpdatePending ? Visibility.Visible : Visibility.Collapsed;
        SettingsUpdateButton.Visibility = settingsOpen && (updates.IsInstalled || UpdatePending)
            ? Visibility.Visible : Visibility.Collapsed;
    }

    private enum StepState { Pending, Active, Done, Failed }

    private static void SetStep(UIElement pending, UIElement active, UIElement done, UIElement failed,
        TextBlock label, StepState state, string text)
    {
        pending.Visibility = state == StepState.Pending ? Visibility.Visible : Visibility.Collapsed;
        active.Visibility = state == StepState.Active ? Visibility.Visible : Visibility.Collapsed;
        done.Visibility = state == StepState.Done ? Visibility.Visible : Visibility.Collapsed;
        failed.Visibility = state == StepState.Failed ? Visibility.Visible : Visibility.Collapsed;
        label.Text = text;
    }

    /// <summary>The update page: the same card as Setup, walking through what an update does.</summary>
    private void RenderUpdateSteps()
    {
        if (!updateView) return;
        // The app's own steps exist only when there is (or was) an app update in this run.
        bool appUpdate = restartedForUpdate || updates.CanRestart || restarting;
        DownloadStep.Visibility = RestartStep.Visibility = appUpdate ? Visibility.Visible : Visibility.Collapsed;
        SetStep(DownloadPending, DownloadActive, DownloadDone, DownloadFailed, DownloadState,
            StepState.Done, "DONE");
        var restart = restartedForUpdate ? StepState.Done : restarting ? StepState.Active : StepState.Pending;
        SetStep(RestartPending, RestartActive, RestartDone, RestartFailed, RestartState, restart,
            restart switch { StepState.Done => "DONE", StepState.Active => "NOW", _ => "" });

        bool usesService = preferences.UsesService;
        ServiceStep.Visibility = usesService ? Visibility.Visible : Visibility.Collapsed;
        var serviceStep =
            serviceUpdateFailure is not null ? StepState.Failed
            : updatingService ? StepState.Active
            : ServiceBehind || service is null ? StepState.Pending
            : StepState.Done;
        SetStep(ServicePending, ServiceActive, ServiceDone, ServiceFailed, ServiceState, serviceStep,
            serviceStep switch
            {
                StepState.Failed => "NOT DONE",
                StepState.Active => "APPROVE",
                StepState.Done => "DONE",
                _ => ServiceBehind || updates.CanRestart ? "" : "CONNECTING",
            });

        bool connecting = usesService && service is null && !ServiceBehind && serviceUpdateFailure is null;
        bool done = !UpdatePending && !updatingService && !restarting && serviceUpdateFailure is null && !connecting;
        UpdateHeading.Text = done ? "Up to date" : "Updating";
        UpdateDetail.Text = serviceUpdateFailure ?? $"Version {ServiceControl.AppVersion}";
        bool busy = updatingService || restarting || connecting;
        UpdateContinueButton.Visibility = busy ? Visibility.Collapsed : Visibility.Visible;
        UpdateContinueButton.Content = done ? "DONE" : serviceUpdateFailure is not null ? "TRY AGAIN" : "CONTINUE";
        if (done && !updateCloseArmed)
        {
            updateCloseArmed = true;
            _ = CloseUpdateViewSoonAsync();
        }
    }

    /// <summary>A finished update shows itself briefly, then the repeater comes back.</summary>
    private async Task CloseUpdateViewSoonAsync()
    {
        await Task.Delay(TimeSpan.FromSeconds(3));
        updateCloseArmed = false;
        if (!updateView || UpdatePending || updatingService || serviceUpdateFailure is not null) return;
        updateView = false;
        Render();
    }

    private void UpdateContinueClicked(object sender, RoutedEventArgs args)
    {
        if (!UpdatePending && serviceUpdateFailure is null)
        {
            updateView = false;
            Render();
            return;
        }
        _ = RunUpdateAsync();
    }

    /// <summary>
    /// Do whatever the update still needs. The app first: the version it restarts into is the one
    /// the service then takes, and that new process finishes the service step on its own.
    /// </summary>
    private async Task RunUpdateAsync()
    {
        if (restarting || switching) return;
        updateView = true;
        serviceUpdateFailure = null;
        Render();
        if (updates.CanRestart)
        {
            restarting = true;
            Render();
            // Long enough to see the step begin before the window goes.
            await Task.Delay(TimeSpan.FromMilliseconds(700));
            await RestartToUpdateAsync();
        }
        else if (ServiceBehind) await UpdateServiceAsync();
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
        catch { _ = NoticeAsync("Settings not saved", "Settings could not be saved."); }
    }

    private async void SaveClicked(object sender, RoutedEventArgs args)
    {
        if (switching) return;
        try
        {
            // The name goes to the host that holds the identity now, before any mode switch moves it.
            if (NameChange() is { } name) await SaveNameAsync(name);
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
            requested = null;
            if (host is not null && snapshot is not null) Reconcile(host, snapshot);
            Render();
            if (preferences.AutoUpdate) _ = CheckUpdatesAsync(false);
            if (StartupChoice.IsOn && StartupRegistration.IsDisabledByWindows())
                await NoticeAsync("Open with Windows is off", "Opening with Windows is disabled in Windows Settings.");
        }
        catch (InvalidOperationException error) { await NoticeAsync("Settings not saved", error.Message); }
        catch { await NoticeAsync("Settings not saved", "Settings could not be saved."); }
    }

    /// <summary>
    /// Move the repeater under the service or back out of it. The running host has to stop first
    /// (it holds the identity); whatever the outcome, a host is started again in the mode that
    /// actually holds the identity afterwards.
    /// </summary>
    private async Task<bool> SwitchModeAsync(bool toService)
    {
        switching = true;
        StatusText.Text = toService ? "INSTALLING SERVICE" : "REMOVING SERVICE";
        Render();
        ServiceVerbResult? result = ServiceVerbResult.Failed;
        try
        {
            if (host is not null) await host.DisposeAsync();
            host = null;
            snapshot = null;
            result = toService
                ? await ServiceControl.InstallAsync(stateDirectory)
                : await ServiceControl.UninstallAsync(stateDirectory);
            bool ok = result == ServiceVerbResult.Ok;
            if (ok) serviceIncompatible = false;
            preferences = preferences with { RunAsService = ok ? toService : preferences.UsesService };
        }
        finally
        {
            switching = false;
            StartHost();
            Render();
        }
        if (result != ServiceVerbResult.Ok)
            await NoticeAsync(toService ? "Service not installed" : "Service not removed", ServiceControl.Describe(result));
        return result == ServiceVerbResult.Ok;
    }

    /// <summary>Replace the service's copy with this app's version. One administrator prompt.</summary>
    private async Task<bool> UpdateServiceAsync()
    {
        if (switching) return false;
        switching = true;
        updatingService = true;
        updateView = true;
        serviceUpdateFailure = null;
        StatusText.Text = "UPDATING";
        Render();
        ServiceVerbResult? result = ServiceVerbResult.Failed;
        try
        {
            if (host is not null) await host.DisposeAsync();
            host = null;
            snapshot = null;
            result = await ServiceControl.InstallAsync(stateDirectory);
            if (result == ServiceVerbResult.Ok) serviceIncompatible = false;
        }
        finally
        {
            switching = false;
            updatingService = false;
            if (result != ServiceVerbResult.Ok)
            {
                pendingName = null;
                serviceUpdateFailure = ServiceControl.Describe(result);
            }
            StartHost();
            Render();
        }
        return result == ServiceVerbResult.Ok;
    }

    private void SettingsClicked(object sender, RoutedEventArgs args)
    {
        if (updateView)
        {
            if (updatingService || restarting) return;
            updateView = false;
            serviceUpdateFailure = null;
            Render();
            return;
        }
        editing = !editing || !preferences.SetupComplete;
        Render();
    }

    private async void CopyClicked(object sender, RoutedEventArgs args)
    {
        if (snapshot?.ClaimUrl is not { } link) return;
        try
        {
            var data = new DataPackage();
            data.SetText(link);
            Clipboard.SetContent(data);
            CopyButton.Content = "COPIED";
        }
        catch { CopyButton.Content = "CLIPBOARD UNAVAILABLE"; }
        await Task.Delay(TimeSpan.FromSeconds(2));
        CopyButton.Content = "COPY CLAIM LINK";
    }

    /// <summary>
    /// Release the repeater from its roster (REPEATERS.md §4.1): the one roster decision made at
    /// the machine, for an owner whose phone is gone, a machine its owner removed, or a claim
    /// that went wrong. Asked once, because it cannot be undone from here.
    /// </summary>
    private async void ReleaseClicked(object sender, RoutedEventArgs args)
    {
        if (ServiceBehind)
        {
            if (await ConfirmUpdateAsync("This repeater needs to finish updating before it can be released."))
                await UpdateServiceAsync();
            return;
        }
        if (host is not { } link || dialogOpen) return;
        var dialog = new ContentDialog
        {
            XamlRoot = Root.XamlRoot,
            Title = "Release this repeater?",
            Content = "It stops carrying everyone and shows a new claim code. This cannot be undone here.",
            PrimaryButtonText = "Release",
            CloseButtonText = "Cancel",
            DefaultButton = ContentDialogButton.Close,
        };
        dialogOpen = true;
        ContentDialogResult answer;
        try { answer = await dialog.ShowAsync(); }
        finally { dialogOpen = false; }
        if (answer != ContentDialogResult.Primary || host != link) return;
        ReleaseButton.IsEnabled = false;
        try
        {
            if (await link.ReleaseAsync())
            {
                editing = false;
                Render();
            }
            else await NoticeAsync("Not released", "The repeater did not confirm the release. Try again.");
        }
        finally { ReleaseButton.IsEnabled = true; }
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
            StartHost();
        }
        finally
        {
            RetryButton.IsEnabled = true;
            retrying = false;
        }
    }

    private async void UpdateClicked(object sender, RoutedEventArgs args)
    {
        if (UpdatePending) await RunUpdateAsync();
        else await CheckUpdatesAsync();
    }

    private async Task CheckUpdatesAsync(bool interactive = true)
    {
        if (checkingUpdates) return;
        checkingUpdates = true;
        if (interactive) lastCheck = null;
        Render();
        try
        {
            var result = await updates.CheckAsync();
            if (quitting) return;
            if (result != UpdateCheck.Busy && (interactive || result == UpdateCheck.Ready)) lastCheck = result;
        }
        finally
        {
            checkingUpdates = false;
            if (!quitting) Render();
        }
    }

    private async Task RestartToUpdateAsync()
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
            restarting = false;
            updateTimer.Start();
            ShowWindow();
            StatusText.Text = "STOPPED";
            snapshot = null;
            SetProblem("The update could not restart the app. Close and reopen the repeater.", true);
        }
    }

    private async Task<bool> ConfirmUpdateAsync(string text)
    {
        if (dialogOpen || Root.XamlRoot is null) return false;
        dialogOpen = true;
        try
        {
            var dialog = new ContentDialog
            {
                XamlRoot = Root.XamlRoot,
                Title = "Update needed",
                Content = text,
                PrimaryButtonText = "Update",
                CloseButtonText = "Cancel",
                DefaultButton = ContentDialogButton.Primary,
            };
            return await dialog.ShowAsync() == ContentDialogResult.Primary;
        }
        finally { dialogOpen = false; }
    }

    /// <summary>The outcome of something the person just asked for, when it did not happen.</summary>
    private async Task NoticeAsync(string title, string text)
    {
        if (dialogOpen || Root.XamlRoot is null || quitting) return;
        dialogOpen = true;
        try
        {
            await new ContentDialog
            {
                XamlRoot = Root.XamlRoot,
                Title = title,
                Content = text,
                CloseButtonText = "OK",
            }.ShowAsync();
        }
        finally { dialogOpen = false; }
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
